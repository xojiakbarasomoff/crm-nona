import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { buildOpenApi, DemoDirectSchema, DemoLeadAdsSchema, LeadAdsConnectSchema } from '@crm/contracts';
import { can } from '@crm/domain';
import { DemoMetaLeadsClient, parseSignedRequest, signMetaBody, type DemoFailure } from '@crm/integrations';
import { AppError } from '../core/errors';
import { eventsChannel, notFound, requireCapOrThrow, type ChangeEvent, type Core, type UserActor } from './platform-helpers';
import { Actor, CORE, parse, Public, requireDemo, send, UuidPipe as uuid, type AuthedRequest } from './common';
import { enqueueOutbox } from '../core/queue';
import { z } from 'zod';

const RetentionSchema = z.object({ rawWebhookDays: z.number().int().min(1).max(3650), technicalLogDays: z.number().int().min(1).max(3650), messageContentMonths: z.number().int().min(1).max(120) }).strict();
const EraseSchema = z.object({ reason: z.string().min(3).max(500) }).strict();

@Controller()
export class PlatformController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  // ---------------- Ops ----------------

  @Public()
  @Get('health')
  health(@Res() res: Response) {
    send(res, 200, { status: 'ok', mode: this.core.deps.config.mode });
  }

  @Public()
  @Get('ready')
  async ready(@Res() res: Response) {
    const checks: Record<string, string> = {};
    try {
      await this.core.deps.prisma.$queryRaw`SELECT 1`;
      checks.db = 'ok';
    } catch {
      checks.db = 'down';
    }
    try {
      checks.redis = (await this.core.deps.redis.ping()) === 'PONG' ? 'ok' : 'down';
    } catch {
      checks.redis = 'down';
    }
    const storage = this.core.deps.adapters.storage as { ping?: () => Promise<boolean> };
    if (storage.ping) checks.storage = (await storage.ping()) ? 'ok' : 'down';
    const ok = Object.values(checks).every((v) => v === 'ok');
    send(res, ok ? 200 : 503, { status: ok ? 'ready' : 'not_ready', checks });
  }

  @Public()
  @Get('api/openapi.json')
  openapi(@Res() res: Response) {
    send(res, 200, buildOpenApi());
  }

  // ---------------- Integrations ----------------

  @Get('api/v1/integrations/health')
  async integrationsHealth(@Actor() actor: UserActor, @Res() res: Response) {
    send(res, 200, await this.core.admin.integrationsHealth(actor));
  }

  @Post('api/v1/integrations/replay/:id')
  async replay(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Res() res: Response) {
    requireCapOrThrow(actor, 'integrations.replay');
    const op = await this.core.processing.replay(actor.companyId, id, actor.id);
    if (!op) throw notFound('Операция');
    send(res, 202, { id: op.id, state: op.state });
  }

  @Post('api/v1/integrations/inbox/:id/replay')
  async replayInbox(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Res() res: Response) {
    requireCapOrThrow(actor, 'integrations.replay');
    const r = await this.core.deps.prisma.webhookInbox.updateMany({ where: { id, companyId: actor.companyId, state: { in: ['dead', 'failed'] } }, data: { state: 'pending', nextAttemptAt: new Date(), attempts: 0 } });
    if (!r.count) throw notFound('Событие');
    send(res, 202, { ok: true });
  }

  // ---------------- Instagram API with Instagram Login (Direct) ----------------

  @Get('api/v1/integrations/instagram/status')
  async igStatus(@Actor() actor: UserActor, @Res() res: Response) {
    requireCapOrThrow(actor, 'integrations.manage');
    send(res, 200, await this.core.instagram.status(actor.companyId));
  }

  @Get('api/v1/integrations/instagram/subscription')
  async igSubscription(@Actor() actor: UserActor, @Res() res: Response) {
    requireCapOrThrow(actor, 'integrations.manage');
    send(res, 200, await this.core.instagram.subscriptionCheck(actor));
  }

  @Get('api/v1/integrations/instagram/inbound-summary')
  async igInboundSummary(@Actor() actor: UserActor, @Query() q: { marker?: string }, @Res() res: Response) {
    requireCapOrThrow(actor, 'integrations.manage');
    send(res, 200, await this.core.instagram.inboundSummary(actor, typeof q.marker === 'string' && q.marker.length >= 3 ? q.marker.slice(0, 64) : null));
  }

  /** Demo yozuvlarni tozalash REJASI (faqat o'qish, administrator). O'chirish bu yerda yo'q. */
  @Get('api/v1/admin/maintenance/demo-cleanup/plan')
  async demoCleanupPlan(@Actor() actor: UserActor, @Res() res: Response) {
    send(res, 200, await this.core.demoCleanup.plan(actor));
  }

  /** Mantiqiy eksport (o'chiriladigan qatorlar to'liq). Faqat administrator. */
  @Get('api/v1/admin/maintenance/demo-cleanup/export')
  async demoCleanupExport(@Actor() actor: UserActor, @Query() q: { contacts?: string; leads?: string }, @Res() res: Response) {
    const list = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
    const include = list(q.contacts).length || list(q.leads).length ? { contacts: list(q.contacts), leads: list(q.leads) } : undefined;
    send(res, 200, await this.core.demoCleanup.export(actor, include));
  }

  /** O'chirish: eksport hash'i va tasdiqlash matni bilan; bitta tranzaksiya. Faqat administrator. */
  @Post('api/v1/admin/maintenance/demo-cleanup/execute')
  async demoCleanupExecute(@Actor() actor: UserActor, @Body() body: { manifestHash?: string; confirm?: string; allowPaymentDeletion?: string; only?: { contacts: string[]; leads: string[]; orders: string[] }; cutoff?: string; include?: { contacts: string[]; leads: string[] } }, @Res() res: Response) {
    send(res, 200, await this.core.demoCleanup.execute(actor, { manifestHash: String(body?.manifestHash ?? ''), confirm: String(body?.confirm ?? ''), allowPaymentDeletion: String(body?.allowPaymentDeletion ?? ''), ...(body?.only ? { only: { contacts: [...body.only.contacts], leads: [...body.only.leads], orders: [...body.only.orders] } } : {}), ...(body?.cutoff ? { cutoff: String(body.cutoff) } : {}), ...(body?.include ? { include: { contacts: [...(body.include.contacts ?? [])], leads: [...(body.include.leads ?? [])] } } : {}) }));
  }

  @Post('api/v1/integrations/instagram/profiles/sync')
  async igProfilesSync(@Actor() actor: UserActor, @Res() res: Response) {
    requireCapOrThrow(actor, 'integrations.manage');
    send(res, 200, await this.core.instagramProfiles.syncNow(actor));
  }

  @Post('api/v1/integrations/instagram/sync-ids')
  async igSyncIds(@Actor() actor: UserActor, @Res() res: Response) {
    requireCapOrThrow(actor, 'integrations.manage');
    send(res, 200, await this.core.instagram.syncProfileIds(actor));
  }

  @Post('api/v1/integrations/instagram/oauth/start')
  async igStart(@Actor() actor: UserActor, @Res() res: Response) {
    send(res, 200, await this.core.instagram.start(actor));
  }

  /** The Meta redirect lands here (through the web domain, so the admin's session cookie is present). */
  @Get('api/v1/integrations/instagram/oauth/callback')
  async igCallback(@Actor() actor: UserActor, @Query() q: Record<string, unknown>, @Res() res: Response) {
    const base = `${this.core.deps.config.appPublicUrl}/integrations`;
    if (typeof q.error === 'string' || typeof q.code !== 'string' || typeof q.state !== 'string') {
      res.redirect(302, `${base}?instagram=denied`);
      return;
    }
    try {
      await this.core.instagram.callback(actor, { code: q.code, state: q.state });
      res.redirect(302, `${base}?connected=instagram`);
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'ERROR';
      res.redirect(302, `${base}?instagram=failed&reason=${encodeURIComponent(code)}`);
    }
  }

  /** Meta "Deauthorize callback URL" (form-encoded `signed_request`). */
  @Public()
  @Post('webhooks/meta/deauthorize')
  async igDeauthorize(@Req() req: AuthedRequest, @Res() res: Response) {
    const sr = new URLSearchParams((req.rawBody ?? Buffer.alloc(0)).toString('utf8')).get('signed_request') ?? '';
    const payload = parseSignedRequest(sr, [this.core.deps.config.meta.appSecret]);
    if (!payload) throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid signed_request');
    const userId = String(payload.user_id ?? '');
    const n = userId ? await this.core.instagram.handleDeauthorize(userId) : 0;
    send(res, 200, { ok: true, paused: n });
  }

  /**
   * Meta "Data deletion request URL". We acknowledge and return a confirmation code; the actual erasure of the
   * person's data is done by an administrator through the existing erasure flow (documented, not automatic).
   */
  @Public()
  @Post('webhooks/meta/data-deletion')
  async igDataDeletion(@Req() req: AuthedRequest, @Res() res: Response) {
    const sr = new URLSearchParams((req.rawBody ?? Buffer.alloc(0)).toString('utf8')).get('signed_request') ?? '';
    const payload = parseSignedRequest(sr, [this.core.deps.config.meta.appSecret]);
    if (!payload) throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid signed_request');
    const code = randomUUID();
    const userId = String(payload.user_id ?? '');
    await this.core.deps.redis.set(`ig_data_deletion:${code}`, JSON.stringify({ userId, at: new Date().toISOString() }), 'EX', 90 * 86400);
    await this.core.instagram.handleDataDeletionRequest(userId, code);
    res.status(200).json({ url: `${this.core.deps.config.appPublicUrl}/data-deletion?code=${code}`, confirmation_code: code });
  }

  @Post('api/v1/integrations/lead-ads/backfill')
  async leadAdsBackfill(@Actor() actor: UserActor, @Body() body: { since?: string }, @Res() res: Response) {
    requireCapOrThrow(actor, 'integrations.manage');
    const since = body?.since && !Number.isNaN(Date.parse(body.since)) ? new Date(body.since).toISOString() : null;
    const id = await this.core.deps.prisma.$transaction((tx) => enqueueOutbox(tx, { companyId: actor.companyId, operationKey: `meta.backfill:${Date.now()}`, target: 'meta', action: 'meta.backfill', payload: { since, requestedBy: actor.id } }));
    send(res, 202, { operationId: id });
  }

  @Get('api/v1/integrations/lead-ads/status')
  async leadAdsStatus(@Actor() actor: UserActor, @Res() res: Response) {
    send(res, 200, await this.core.leadAds.status(actor));
  }

  @Post('api/v1/integrations/lead-ads/oauth/start')
  async leadAdsStart(@Actor() actor: UserActor, @Res() res: Response) {
    send(res, 200, await this.core.leadAds.start(actor));
  }

  @Get('api/v1/integrations/lead-ads/oauth/callback')
  async leadAdsCallback(@Actor() actor: UserActor, @Query() q: Record<string, unknown>, @Res() res: Response) {
    const base = `${this.core.deps.config.appPublicUrl}/integrations`;
    if (typeof q.error === 'string' || typeof q.code !== 'string' || typeof q.state !== 'string') return void res.redirect(302, `${base}?lead_ads=denied`);
    try {
      await this.core.leadAds.callback(actor, { code: q.code, state: q.state });
      res.redirect(302, `${base}?lead_ads=select_page`);
    } catch (err) {
      res.redirect(302, `${base}?lead_ads=failed&reason=${encodeURIComponent((err as { code?: string }).code ?? 'META_ERROR')}`);
    }
  }

  @Get('api/v1/integrations/lead-ads/forms')
  async leadAdsForms(@Actor() actor: UserActor, @Query('pageId') pageId: string, @Res() res: Response) {
    send(res, 200, await this.core.leadAds.forms(actor, typeof pageId === 'string' ? pageId : ''));
  }

  @Post('api/v1/integrations/lead-ads/connect')
  async leadAdsConnect(@Actor() actor: UserActor, @Body() body: unknown, @Res() res: Response) {
    send(res, 200, await this.core.leadAds.connect(actor, parse(LeadAdsConnectSchema, body)));
  }

  @Get('api/v1/privacy/retention')
  async retention(@Actor() actor: UserActor, @Res() res: Response) {
    requireCapOrThrow(actor, 'integrations.manage');
    send(res, 200, { policy: await this.core.privacy.policy(actor.companyId) });
  }

  @Post('api/v1/privacy/retention/confirm')
  async confirmRetention(@Actor() actor: UserActor, @Body() body: unknown, @Res() res: Response) {
    const input = parse(RetentionSchema, body);
    send(res, 200, { policy: await this.core.privacy.confirmPolicy(actor, input) });
  }

  @Post('api/v1/privacy/retention/run')
  async runRetention(@Actor() actor: UserActor, @Res() res: Response) {
    requireCapOrThrow(actor, 'integrations.manage');
    send(res, 200, await this.core.privacy.runRetention(actor.companyId));
  }

  @Post('api/v1/contacts/:id/erase')
  async erase(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, 200, await this.core.privacy.eraseContact(actor, id, parse(EraseSchema, body).reason));
  }

  @Post('api/v1/integrations/:id/disconnect')
  async disconnect(@Actor() actor: UserActor, @Param('id', uuid) id: string, @Res() res: Response) {
    await this.core.instagram.disconnect(actor, id);
    send(res, 200, { ok: true });
  }

  // ---------------- SSE (TZ §15.3) ----------------

  /**
   * Each event is forwarded only after a fresh DB access check for that user; the session itself is
   * re-validated every 15 s so blocked users / reassigned managers lose access promptly.
   */
  @Get('api/v1/events')
  async events(@Actor() actor: UserActor, @Req() req: AuthedRequest, @Res() res: Response) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`event: ready\ndata: {"at":"${new Date().toISOString()}"}\n\n`);
    const sub: Redis = this.core.deps.redis.duplicate();
    sub.on('error', () => undefined);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      sub.disconnect();
      res.end();
    };
    const timer = setInterval(async () => {
      const info = await this.core.auth.resolveSession(req.cookies?.crm_session).catch(() => null);
      if (!info || info.actor.id !== actor.id) return close();
      res.write(`: ping\n\n`);
    }, 15_000);
    req.on('close', close);
    try {
      await sub.subscribe(eventsChannel(actor.companyId));
    } catch {
      res.write(`event: degraded\ndata: {"reason":"realtime_unavailable"}\n\n`);
      return;
    }
    sub.on('message', async (_ch, raw) => {
      const e = JSON.parse(raw) as ChangeEvent;
      if (await this.canSee(actor, e)) res.write(`event: change\ndata: ${JSON.stringify({ entityType: e.entityType, entityId: e.entityId, kind: e.kind, at: e.at })}\n\n`);
    });
  }

  private async canSee(actor: UserActor, e: ChangeEvent): Promise<boolean> {
    const p = this.core.deps.prisma;
    if (e.companyId !== actor.companyId) return false;
    if (e.entityType === 'notification') return e.userId === actor.id;
    if (can(actor.role, 'records.view_all')) return true;
    switch (e.entityType) {
      case 'lead':
        return !!(await p.lead.findFirst({ where: { id: e.entityId, companyId: actor.companyId, ownerId: actor.id }, select: { id: true } }));
      case 'order':
        return !!(await p.order.findFirst({ where: { id: e.entityId, companyId: actor.companyId, ownerId: actor.id }, select: { id: true } }));
      case 'segment':
        return !!(await p.flightSegment.findFirst({ where: { id: e.entityId, companyId: actor.companyId, order: { ownerId: actor.id } }, select: { id: true } }));
      case 'reminder':
        return !!(await p.reminderOccurrence.findFirst({ where: { id: e.entityId, companyId: actor.companyId, assigneeId: actor.id }, select: { id: true } }));
      case 'conversation': {
        const c = await p.conversation.findFirst({ where: { id: e.entityId, companyId: actor.companyId }, select: { leadId: true } });
        return !!c?.leadId && !!(await p.lead.findFirst({ where: { id: c.leadId, ownerId: actor.id }, select: { id: true } }));
      }
      default:
        return false;
    }
  }

  // ---------------- Webhooks (TZ §18.1, §19.1) ----------------

  @Public()
  @Get('webhooks/meta')
  metaVerify(@Query() q: Record<string, unknown>, @Res() res: Response) {
    res.status(200).type('text/plain').send(this.core.webhooks.metaVerify(q));
  }

  @Public()
  @Post('webhooks/meta')
  async meta(@Req() req: AuthedRequest, @Headers('x-hub-signature-256') sig: string | undefined, @Res() res: Response) {
    send(res, 200, await this.core.webhooks.metaReceive(req.rawBody ?? Buffer.alloc(0), sig));
  }

  // ---------------- DEMO simulators (APP_MODE=demo only) ----------------

  /** Simulates a Lead Ads form submission end-to-end through the real webhook path. */
  @Post('api/v1/demo/lead-ads')
  async demoLeadAds(@Actor() actor: UserActor, @Body() body: unknown, @Res() res: Response) {
    requireDemo(this.core);
    requireCapOrThrow(actor, 'integrations.manage');
    const input = parse(DemoLeadAdsSchema, body);
    const conn = await this.core.deps.prisma.integrationConnection.findFirstOrThrow({ where: { companyId: actor.companyId, provider: 'META_LEADS', mode: 'demo' } });
    const leadgenId = `demo_${Date.now()}_${randomUUID().slice(0, 6)}`;
    const leads = this.core.deps.adapters.metaLeads as DemoMetaLeadsClient;
    await leads.registerLead({
      leadgenId,
      createdTime: new Date(),
      formId: 'demo_form_1',
      adId: input.adId ?? null,
      adsetId: null,
      campaignId: input.adId ? 'demo_campaign_1' : null,
      platform: input.platform ?? null,
      fields: { full_name: input.fullName, ...(input.phone ? { phone_number: input.phone } : {}), ...(input.email ? { email: input.email } : {}), ...(input.destination ? { destination: input.destination } : {}) },
    });
    const payload = Buffer.from(JSON.stringify({ object: 'page', entry: [{ id: conn.accountId, time: Math.floor(Date.now() / 1000), changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: conn.accountId, form_id: 'demo_form_1', ad_id: input.adId ?? undefined, created_time: Math.floor(Date.now() / 1000) } }] }] }));
    send(res, 202, { leadgenId, ...(await this.core.webhooks.metaReceive(payload, signMetaBody(payload, this.core.webhooks.signingSecretFor(payload).secret))) });
  }

  @Post('api/v1/demo/direct')
  async demoDirect(@Actor() actor: UserActor, @Body() body: unknown, @Res() res: Response) {
    requireDemo(this.core);
    requireCapOrThrow(actor, 'integrations.manage');
    const input = parse(DemoDirectSchema, body);
    const conn = await this.core.deps.prisma.integrationConnection.findFirstOrThrow({ where: { companyId: actor.companyId, provider: 'META_DIRECT', mode: 'demo' } });
    const mid = `demo_mid_in_${randomUUID()}`;
    const payload = Buffer.from(
      JSON.stringify({
        object: 'instagram',
        entry: [{ id: conn.accountId, time: Date.now(), messaging: [{ sender: { id: input.scopedSenderId }, recipient: { id: conn.accountId }, timestamp: Date.now(), message: { mid, text: input.text, ...(input.referralAdId ? { referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: input.referralAdId } } : {}) } }] }],
      }),
    );
    send(res, 202, { mid, ...(await this.core.webhooks.metaReceive(payload, signMetaBody(payload, this.core.webhooks.signingSecretFor(payload).secret))) });
  }

  @Post('api/v1/demo/fail-next')
  async demoFail(@Actor() actor: UserActor, @Body() body: { target: string; failure: DemoFailure; times?: number }, @Res() res: Response) {
    requireDemo(this.core);
    requireCapOrThrow(actor, 'integrations.manage');
    await this.core.deps.adapters.demoStore!.injectFailure(body.target, body.failure, body.times ?? 1);
    send(res, 200, { ok: true });
  }
}
