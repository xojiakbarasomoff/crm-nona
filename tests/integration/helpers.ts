import { createHmac, randomUUID } from 'node:crypto';
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
    AMO_CLIENT_ID: 'test-client',
    AMO_CLIENT_SECRET: 'test-secret',
    AMO_REDIRECT_URI: 'https://crm.example.test/oauth',
    AMO_ALLOWED_DOMAINS: 'demo-turizm.amocrm.ru',
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
    const [next, keys] = await core.deps.redis.scan(cursor, 'MATCH', 'demo:fail:*', 'COUNT', 500);
    if (keys.length) await core.deps.redis.del(...keys);
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
  cookie: string;
}

export async function login(app: INestApplication, email: string): Promise<Session> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: DEMO_PASSWORD, ...(email.startsWith('admin') ? { totp: totpCode(DEMO_ADMIN_TOTP_SECRET) } : {}) });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  const csrf = res.body.csrfToken as string;
  const srv = app.getHttpServer();
  return {
    cookie,
    get: (p) => request(srv).get(p).set('Cookie', cookie),
    post: (p, b, h = {}) => request(srv).post(p).set('Cookie', cookie).set('X-CSRF-Token', csrf).set(h).send(b as object),
    patch: (p, b) => request(srv).patch(p).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(b as object),
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
    createdTime: new Date(),
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

export async function sendChatReply(app: INestApplication, core: Core, p: { conversationId: string; receiver: string; text: string; authorAmoUserId: string; amoMessageId?: string }) {
  const conn = await core.deps.prisma.integrationConnection.findFirstOrThrow({ where: { provider: 'AMOCRM_CHATS' } });
  const raw = Buffer.from(JSON.stringify({ account_id: 'demo_scope', time: 1, message: { receiver: { client_id: p.receiver }, sender: { id: p.authorAmoUserId }, conversation: { client_id: p.conversationId }, timestamp: Math.floor(Date.now() / 1000), message: { id: p.amoMessageId ?? `amo_${randomUUID()}`, type: 'text', text: p.text } } }));
  const sig = createHmac('sha1', core.deps.config.amoChats.secret).update(raw).digest('hex');
  return request(app.getHttpServer()).post(`/webhooks/amocrm/chat/${conn.routeToken}`).set('Content-Type', 'application/json').set("X-Signature", sig).send(raw.toString());
}

export async function amoCrmSignal(app: INestApplication, core: Core, amoLeadId: string, version = Date.now()) {
  const conn = await core.deps.prisma.integrationConnection.findFirstOrThrow({ where: { provider: 'AMOCRM_REST' } });
  return request(app.getHttpServer())
    .post(`/webhooks/amocrm/crm/${conn.routeToken}`)
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(`leads[status][0][id]=${amoLeadId}&leads[status][0][updated_at]=${version}&account[id]=${conn.accountId}`);
}

/** Creates a lead through the Lead Ads path and returns it after amoCRM linking. */
export async function newLead(app: INestApplication, core: Core, name = `Mijoz ${randomUUID().slice(0, 6)}`, phone?: string) {
  const { leadgenId, res: whRes } = await sendLeadAds(app, core, { fullName: name, phone: phone ?? `+99890${Math.floor(1_000_000 + Math.random() * 8_999_999)}`, platform: 'ig' });
  await drain(core);
  const inquiry = await core.deps.prisma.inquiry.findFirst({ where: { providerEventKey: `meta_leads:${leadgenId}` } });
  if (!inquiry) {
    const rows = await core.deps.prisma.webhookInbox.findMany({ where: { externalEventId: `leadgen:${leadgenId}` } });
    throw new Error(`inquiry missing; webhook=${whRes.status} ${JSON.stringify(whRes.body)}; inbox=${JSON.stringify(rows.map((r) => [r.state, r.lastError]))}`);
  }
  return core.deps.prisma.lead.findUniqueOrThrow({ where: { id: inquiry.leadId! } });
}

export const companyId = DEMO_COMPANY_ID;
