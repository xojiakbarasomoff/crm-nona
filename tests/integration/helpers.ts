import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../../apps/api/src/app';
import { createCore, loadConfig, type Clock, type Core } from '../../apps/api/src/core';
import { DEMO_ADMIN_TOTP_SECRET, DEMO_COMPANY_ID, DEMO_IG_BUSINESS_ID, DEMO_PAGE_ID, DEMO_PASSWORD } from '../../packages/database/src/seed';
import { totpCode } from '../../apps/api/src/core/totp';
import { signMetaBody, type DemoMetaLeadsClient, type FetchLike } from '@crm/integrations';

process.loadEnvFile?.(join(__dirname, '..', '..', '.env'));

export { DEMO_COMPANY_ID, DEMO_IG_BUSINESS_ID, DEMO_PAGE_ID };

export class TestClock implements Clock {
  private offsetMs = 0;
  private frozen: Date | null = null;
  now() {
    return this.frozen ? new Date(this.frozen) : new Date(Date.now() + this.offsetMs);
  }
  set(d: Date) {
    this.frozen = d;
  }
  advance(ms: number) {
    if (this.frozen) this.frozen = new Date(this.frozen.getTime() + ms);
    else this.offsetMs += ms;
  }
  real() {
    this.frozen = null;
    this.offsetMs = 0;
  }
}

export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...process.env,
    APP_MODE: 'demo',
    DATABASE_URL: inject('dbUrl'),
    REDIS_URL: process.env.TEST_REDIS_URL!,
    LOG_LEVEL: 'silent',
    COOKIE_SECURE: 'false',
    ...overrides,
  });
}

export function makeCore(opts: { clock?: Clock; fetchImpl?: FetchLike; env?: Record<string, string> } = {}): Core {
  return createCore(testConfig(opts.env), { clock: opts.clock, fetchImpl: opts.fetchImpl });
}

/** Per-file isolation: drop leftover demo failures and run pending work from earlier files. */
export async function isolate(core: Core) {
  const store = core.deps.adapters.demoStore!;
  let cursor = '0';
  do {
    const [next, keys] = await core.deps.redis.scan(cursor, 'MATCH', '*', 'COUNT', 500);
    const drop = keys.filter((k) => k.startsWith('demo:fail:') || k.startsWith('dash:'));
    if (drop.length) await core.deps.redis.del(...drop);
    cursor = next;
  } while (cursor !== '0');
  void store;
  await core.deps.prisma.outboxOperation.updateMany({ where: { state: { in: ['failed', 'pending'] } }, data: { nextAttemptAt: new Date(0) } });
  await drain(core, 50);
}

export async function makeApp(core: Core): Promise<INestApplication> {
  await isolate(core);
  const app = await createApp(core);
  await app.init();
  return app;
}

export interface Session {
  get(path: string): request.Test;
  post(path: string, body?: unknown, headers?: Record<string, string>): request.Test;
  patch(path: string, body?: unknown): request.Test;
  delete(path: string): request.Test;
  cookie: string;
}

/** `at` — serverning soati (TestClock) bo'lsa, administrator TOTP kodi shu lahza uchun hisoblanadi. */
export async function login(app: INestApplication, email: string, at: number = Date.now()): Promise<Session> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: DEMO_PASSWORD, ...(email.startsWith('admin') ? { totp: totpCode(DEMO_ADMIN_TOTP_SECRET, at) } : {}) });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  const csrf = res.body.csrfToken as string;
  const srv = app.getHttpServer();
  return {
    cookie,
    get: (p) => request(srv).get(p).set('Cookie', cookie),
    post: (p, b, h = {}) => request(srv).post(p).set('Cookie', cookie).set('X-CSRF-Token', csrf).set(h).send(b as object),
    patch: (p, b) => request(srv).patch(p).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(b as object),
    delete: (p) => request(srv).delete(p).set('Cookie', cookie).set('X-CSRF-Token', csrf),
  };
}

/** Processes inbox and outbox synchronously until nothing is runnable (no BullMQ needed in tests). */
export async function drain(core: Core, rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    const inbox = await core.processing.claimInboxBatch(200);
    for (const id of inbox) await core.processing.processInbox(id);
    const outbox = await core.processing.claimOutboxBatch(200);
    for (const id of outbox) await core.processing.executeOutbox(id);
    if (!inbox.length && !outbox.length) return;
  }
}

export async function userId(core: Core, email: string) {
  return (await core.deps.prisma.user.findUniqueOrThrow({ where: { email } })).id;
}

/** Sends a signed Meta leadgen webhook through the real HTTP endpoint. */
export async function sendLeadAds(app: INestApplication, core: Core, p: { fullName: string; phone?: string; email?: string; platform?: string | null; adId?: string | null; leadgenId?: string }) {
  const leadgenId = p.leadgenId ?? `t_${randomUUID()}`;
  await (core.deps.adapters.metaLeads as DemoMetaLeadsClient).registerLead({
    leadgenId,
    // Sinov soati (TestClock) bo'lsa, navbatchilik jadvali shu vaqt bo'yicha baholanadi (assignment `at` = manba vaqti).
    createdTime: core.deps.clock.now(),
    formId: 'form_t',
    adId: p.adId ?? null,
    adsetId: null,
    campaignId: null,
    platform: p.platform ?? null,
    fields: { full_name: p.fullName, ...(p.phone ? { phone_number: p.phone } : {}), ...(p.email ? { email: p.email } : {}) },
  });
  const body = Buffer.from(JSON.stringify({ object: 'page', entry: [{ id: DEMO_PAGE_ID, time: 1, changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: DEMO_PAGE_ID, form_id: 'form_t', ad_id: p.adId ?? undefined } }] }] }));
  const res = await request(app.getHttpServer()).post('/webhooks/meta').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signMetaBody(body, core.deps.config.meta.appSecret)).send(body.toString());
  return { res, leadgenId, body };
}

export async function sendDirect(app: INestApplication, core: Core, p: { sender: string; text?: string; mid?: string; echo?: boolean; referralAdId?: string; timestamp?: number }) {
  const mid = p.mid ?? `mid_${randomUUID()}`;
  const ts = p.timestamp ?? Date.now();
  const message = { mid, text: p.text ?? 'Salom', ...(p.echo ? { is_echo: true } : {}), ...(p.referralAdId ? { referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: p.referralAdId } } : {}) };
  const msg = p.echo ? { sender: { id: DEMO_IG_BUSINESS_ID }, recipient: { id: p.sender }, timestamp: ts, message } : { sender: { id: p.sender }, recipient: { id: DEMO_IG_BUSINESS_ID }, timestamp: ts, message };
  const body = Buffer.from(JSON.stringify({ object: 'instagram', entry: [{ id: DEMO_IG_BUSINESS_ID, time: ts, messaging: [msg] }] }));
  const res = await request(app.getHttpServer()).post('/webhooks/meta').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signMetaBody(body, core.deps.config.meta.appSecret)).send(body.toString());
  return { res, mid };
}

/** Creates a lead through the Lead Ads path and returns it after processing the inbox. */
export async function newLead(app: INestApplication, core: Core, name = `Mijoz ${randomUUID().slice(0, 6)}`, phone?: string) {
  const { leadgenId, res: whRes } = await sendLeadAds(app, core, { fullName: name, phone: phone ?? `+99890${Math.floor(1_000_000 + Math.random() * 8_999_999)}`, platform: 'ig' });
  // Navbatchi menejer `webhook_inbox.received_at` lahzasi bo'yicha tanlanadi (u DB `now()` bilan yoziladi, ya'ni soat
  // injeksiyasiga bo'ysunmaydi). Sinov soati qat'iy bo'lsa, shu lahza ham sinov soatiga tenglashtiriladi.
  if (core.deps.clock instanceof TestClock) {
    await core.deps.prisma.webhookInbox.updateMany({ where: { externalEventId: `leadgen:${leadgenId}` }, data: { receivedAt: core.deps.clock.now() } });
  }
  await drain(core);
  const inquiry = await core.deps.prisma.inquiry.findFirst({ where: { providerEventKey: `meta_leads:${leadgenId}` } });
  if (!inquiry) {
    const rows = await core.deps.prisma.webhookInbox.findMany({ where: { externalEventId: `leadgen:${leadgenId}` } });
    throw new Error(`inquiry missing; webhook=${whRes.status} ${JSON.stringify(whRes.body)}; inbox=${JSON.stringify(rows.map((r) => [r.state, r.lastError]))}`);
  }
  return core.deps.prisma.lead.findUniqueOrThrow({ where: { id: inquiry.leadId! } });
}

export const companyId = DEMO_COMPANY_ID;

/**
 * Fixture: barcha navbatchi menejerlar har doim ish vaqtida (jadvalsiz) va mavjud. Bu testlar haqiqiy soat/hafta kuniga
 * bog'lanib qolmasligi uchun: lid egasi menejer bo'lishi kerak bo'lgan fayllar buni beforeAll'da chaqiradi.
 * (Ish kuni/yakshanba holatlari aniq soat bilan compliance.test.ts da alohida tekshiriladi.)
 */
export async function alwaysOnDuty(core: Core) {
  await core.deps.prisma.managerPoolMember.updateMany({ data: { schedule: null as never, available: true } });
}

/** Tasdiqlangan sotuv: lid «Sotuv yakunlandi» bosqichiga o‘tadi (o‘tish qoidalari lead-ownership.test.ts da alohida tekshiriladi). */
export async function markWon(core: Core, leadId: string, at: Date = new Date(Date.now() + 1000)) {
  const lead = await core.deps.prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  await core.deps.prisma.lead.update({ where: { id: leadId }, data: { stage: 'WON', closedAt: at, firstWonAt: lead.firstWonAt ?? at, version: { increment: 1 } } });
  await core.deps.prisma.leadEvent.create({ data: { companyId: lead.companyId, leadId, kind: 'stage_change', oldStage: lead.stage, newStage: 'WON', origin: 'local', effectiveAt: at, observedAt: at } });
}
