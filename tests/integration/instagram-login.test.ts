import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { GraphMetaDirectClient, signMetaBody } from '@crm/integrations';
import { alwaysOnDuty, drain, login, makeApp, makeCore, sendChatReply, type Session } from './helpers';

/**
 * Instagram API with Instagram Login (Direct). Meta serverlari chaqirilmaydi: barcha HTTP chaqiruvlar sinov
 * fetch'i bilan almashtirilgan (Meta javoblari hujjatdagi shaklda). Bu haqiqiy akkauntda tasdiqlash EMAS.
 */
const IG_ID = '17841400000000001';
const IG_SECRET = 'ig-test-secret'; // faqat OAuth (token almashish) uchun
const APP_SECRET = 'meta-app-secret'; // webhook imzosi: hujjatdagi «your app's App Secret» (META_APP_SECRET)
const calls: Array<{ url: string; method: string; body: string | null }> = [];
let behavior: 'ok' | 'personal' = 'ok';

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
async function metaFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = String(input);
  calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null });
  if (url.startsWith('https://api.instagram.com/oauth/access_token')) return json({ data: [{ access_token: 'SHORT_TOKEN', user_id: IG_ID, permissions: 'instagram_business_basic,instagram_business_manage_messages' }] });
  if (url.startsWith('https://graph.instagram.com/access_token')) return json({ access_token: 'LONG_TOKEN_1', token_type: 'bearer', expires_in: 5183944 });
  if (url.startsWith('https://graph.instagram.com/refresh_access_token')) return json({ access_token: 'LONG_TOKEN_2', token_type: 'bearer', expires_in: 5183944 });
  if (/graph\.instagram\.com\/v[\d.]+\/me\?/.test(url)) return json({ user_id: IG_ID, username: 'nona_travel', account_type: behavior === 'personal' ? 'PERSONAL' : 'BUSINESS' });
  if (url.includes('/subscribed_apps')) return json({ success: true });
  if (url.endsWith('/me/messages')) return json({ recipient_id: 'x', message_id: `mid.live.${randomUUID()}` });
  return json({ error: { message: `unexpected ${url}` } }, 500);
}

let core: Core;
let app: INestApplication;
let admin: Session;
let mgr: Session;
const p = () => core.deps.prisma;

beforeAll(async () => {
  core = makeCore({
    fetchImpl: metaFetch,
    env: { INSTAGRAM_APP_ID: 'ig-app-id', INSTAGRAM_APP_SECRET: IG_SECRET, META_GRAPH_VERSION: 'v23.0', INSTAGRAM_REDIRECT_URI: 'https://crm.example.test/api/v1/integrations/instagram/oauth/callback', META_APP_SECRET: APP_SECRET },
  });
  await alwaysOnDuty(core);
  app = await makeApp(core);
  admin = await login(app, 'admin@demo.local');
  mgr = await login(app, 'menejer.a@demo.local');
  // Haqiqiy Instagram mijozi o'rniga yozuvli sinov klienti (marshrutlash va so'rov shaklini tekshirish uchun)
  (core.deps.adapters as unknown as { metaDirectLive: unknown }).metaDirectLive = new GraphMetaDirectClient('v23.0', 'instagram_login', metaFetch);
});
afterAll(async () => {
  await app.close();
  await core.close();
});

async function connect() {
  const start = await admin.post('/api/v1/integrations/instagram/oauth/start', {});
  expect(start.status).toBe(200);
  const url = new URL(start.body.authorizeUrl);
  const cb = await admin.get(`/api/v1/integrations/instagram/oauth/callback?code=AUTH_CODE%23_&state=${encodeURIComponent(url.searchParams.get('state')!)}`);
  return { start, url, cb };
}

describe('Instagram Login: ulash (OAuth)', () => {
  it('faqat integrations.manage; authorize URL Instagram Login yo‘li (Facebook emas), kerakli ruxsatlar bilan', async () => {
    expect((await mgr.post('/api/v1/integrations/instagram/oauth/start', {})).status).toBe(403);
    const { url } = await connect();
    expect(url.origin + url.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('ig-app-id');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('instagram_business_basic,instagram_business_manage_messages');
    expect(url.searchParams.get('redirect_uri')).toBe('https://crm.example.test/api/v1/integrations/instagram/oauth/callback');
    expect(url.toString()).not.toContain('facebook.com');
  });

  it('callback: kod → qisqa token → uzun token → profil → webhook obunasi; ulanish live, token shifrlangan', async () => {
    calls.length = 0;
    const { cb } = await connect();
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain('connected=instagram');
    const conn = await p().integrationConnection.findFirstOrThrow({ where: { provider: 'META_DIRECT', accountId: IG_ID } });
    expect(conn).toMatchObject({ mode: 'live', health: 'degraded', disconnectedAt: null });
    expect(conn.credentialsEnc).not.toContain('LONG_TOKEN');
    expect(conn.expiresAt!.getTime() - Date.now()).toBeGreaterThan(59 * 86_400_000);
    expect(conn.settings).toMatchObject({ username: 'nona_travel', accountType: 'BUSINESS', login: 'instagram_login', webhookSubscribed: true });
    const exchange = calls.find((c) => c.url.startsWith('https://api.instagram.com/oauth/access_token'))!;
    expect(exchange.method).toBe('POST');
    expect(exchange.body).toContain('code=AUTH_CODE'); // "#_" qo'shimchasi olib tashlangan
    expect(exchange.body).not.toContain('%23_');
    const sub = calls.find((c) => c.url.includes('/subscribed_apps'))!;
    // Hujjatdagi shakl: POST graph.instagram.com/<ver>/<IG_ID>/subscribed_apps, subscribed_fields + access_token (Instagram User token)
    expect(sub.url).toContain(`https://graph.instagram.com/v23.0/${IG_ID}/subscribed_apps?subscribed_fields=messages%2Cmessaging_seen&access_token=LONG_TOKEN_1`);
    expect(sub.method).toBe('POST');
    // Credential kiritildi, lekin haqiqiy sinov o'tmagan: «faol/tayyor» emas
    expect(conn).toMatchObject({ health: 'degraded', healthReason: 'awaiting_live_verification' });
    const st = (await admin.get('/api/v1/integrations/instagram/status')).body;
    expect(st.connections.find((x: { accountId: string }) => x.accountId === IG_ID)).toMatchObject({ state: 'not_ready', verifiedInboundAt: null, verifiedOutboundAt: null });
    expect(await p().auditLog.count({ where: { entityId: conn.id, action: 'connected' } })).toBeGreaterThan(0);
  });

  it('state bir martalik: qayta ishlatish yoki begona state rad etiladi; professional bo‘lmagan akkaunt ulanmaydi', async () => {
    const { start } = await connect();
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    const replay = await admin.get(`/api/v1/integrations/instagram/oauth/callback?code=X&state=${encodeURIComponent(state)}`);
    expect(replay.headers.location).toContain('instagram=failed');
    expect(replay.headers.location).toContain('OAUTH_STATE_INVALID');
    const forged = await admin.get('/api/v1/integrations/instagram/oauth/callback?code=X&state=forged');
    expect(forged.headers.location).toContain('OAUTH_STATE_INVALID');
    const denied = await admin.get('/api/v1/integrations/instagram/oauth/callback?error=access_denied');
    expect(denied.headers.location).toContain('instagram=denied');

    await p().integrationConnection.deleteMany({ where: { provider: 'META_DIRECT', accountId: IG_ID } });
    behavior = 'personal';
    const { cb } = await connect();
    behavior = 'ok';
    expect(cb.headers.location).toContain('INSTAGRAM_NOT_PROFESSIONAL');
    expect(await p().integrationConnection.count({ where: { provider: 'META_DIRECT', accountId: IG_ID } })).toBe(0);
    await connect(); // qayta ulash (keyingi testlar uchun)
  });
});

describe('Instagram Login: kiruvchi Direct → kontakt/lid → mas’ul → javob', () => {
  const sender = `ig_${Date.now()}`;
  const hook = (mid: string, text: string, secret = APP_SECRET, accountId = IG_ID) => {
    const body = Buffer.from(JSON.stringify({ object: 'instagram', entry: [{ id: accountId, time: Date.now(), messaging: [{ sender: { id: sender }, recipient: { id: accountId }, timestamp: Date.now(), message: { mid, text } }] }] }));
    return request(app.getHttpServer()).post('/webhooks/meta').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signMetaBody(body, secret)).send(body.toString());
  };
  const subscribe = (q: Record<string, string>) => request(app.getHttpServer()).get('/webhooks/meta').query(q);

  it('webhook imzosi: faqat hujjatlashtirilgan App Secret (META_APP_SECRET); boshqa sir (jumladan Instagram app secret) rad etiladi va hodisa saqlanmaydi', async () => {
    const before = await p().webhookInbox.count();
    expect((await hook('m0', 'x', 'wrong-secret')).status).toBe(401);
    expect((await hook('m0b', 'x', IG_SECRET)).status).toBe(401); // zaxira sir yo'q
    expect(await p().webhookInbox.count()).toBe(before);
    expect((await hook(`mid.sig.${sender}`, 'imzo', APP_SECRET)).status).toBe(200);
  });

  it('akkaunt ID mos kelmasa (entry.id ≠ ulangan IG user_id) hodisa saqlanmaydi va qayta ishlanmaydi', async () => {
    const before = await p().webhookInbox.count();
    const r = await hook(`mid.foreign.${sender}`, 'begona akkaunt', APP_SECRET, '17841499999999999');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: 1, stored: 0 });
    await drain(core);
    expect(await p().webhookInbox.count()).toBe(before);
    expect(await p().message.count({ where: { providerMessageId: `mid.foreign.${sender}` } })).toBe(0);
    expect(Number(await core.deps.redis.get('metrics:webhook_unknown_account'))).toBeGreaterThanOrEqual(1);
  });

  it('birinchi xabar kontakt, lid va mas’ul menejer yaratadi; keyingi xabarlar va qayta yetkazish takroriy lid yaratmaydi', async () => {
    const m1 = `mid.1.${sender}`;
    expect((await hook(m1, 'Salom, Dubayga tur narxi?')).status).toBe(200);
    await drain(core);
    const conn = await p().integrationConnection.findFirstOrThrow({ where: { provider: 'META_DIRECT', accountId: IG_ID } });
    const conv = await p().conversation.findFirstOrThrow({ where: { connectionId: conn.id, scopedPeerId: sender } });
    expect(conv.leadId).not.toBeNull();
    const lead = await p().lead.findUniqueOrThrow({ where: { id: conv.leadId! } });
    expect(lead.firstSource).toBe('instagram_direct');
    expect(lead.ownerId).not.toBeNull(); // mas'ul menejer biriktirilgan
    expect((await p().user.findUniqueOrThrow({ where: { id: lead.ownerId! } })).role).toBe('MANAGER');

    expect((await hook(`mid.2.${sender}`, 'Yana savol')).status).toBe(200);
    expect((await hook(m1, 'Salom, Dubayga tur narxi?')).status).toBe(200); // Meta qayta yetkazdi (bir xil mid)
    await drain(core);
    const leads = await p().lead.count({ where: { contactId: lead.contactId, deletedAt: null } });
    expect(leads).toBe(1);
    // Haqiqiy imzolangan va akkaunti mos kiruvchi xabar qayta ishlandi: kiruvchi tasdiqlandi, lekin chiquvchi sinovsiz «tayyor» emas
    const afterIn = await p().integrationConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(afterIn).toMatchObject({ health: 'degraded', healthReason: 'awaiting_live_verification' });
    expect((await admin.get('/api/v1/integrations/instagram/status')).body.connections[0].state).toBe('inbound_verified');
    expect(await p().message.count({ where: { conversationId: conv.id, direction: 'inbound' } })).toBe(3); // mid.sig (oldingi test) + mid.1 + mid.2; qayta yetkazilgan mid.1 sanalmagan
    expect(await p().conversation.count({ where: { connectionId: conn.id, scopedPeerId: sender } })).toBe(1);
  });

  it('javob: amoCRM chat javobi → live Instagram mijozi orqali yuboriladi (demo adapter emas); xabar «accepted», «delivered» emas', async () => {
    const conn = await p().integrationConnection.findFirstOrThrow({ where: { provider: 'META_DIRECT', accountId: IG_ID } });
    const conv = await p().conversation.findFirstOrThrow({ where: { connectionId: conn.id, scopedPeerId: sender } });
    const lead = await p().lead.findUniqueOrThrow({ where: { id: conv.leadId! } });
    const owner = await p().user.findUniqueOrThrow({ where: { id: lead.ownerId! } });
    calls.length = 0;
    const r = await sendChatReply(app, core, { conversationId: conv.id, receiver: sender, text: 'Assalomu alaykum! Narxlarni yuboramiz.', authorAmoUserId: owner.amoUserId! });
    expect(r.status).toBe(200);
    await drain(core);
    const send = calls.find((c) => c.url.endsWith('/me/messages'))!;
    expect(send.url).toBe('https://graph.instagram.com/v23.0/me/messages');
    expect(JSON.parse(send.body!)).toMatchObject({ recipient: { id: sender }, message: { text: 'Assalomu alaykum! Narxlarni yuboramiz.' } });
    const out = await p().message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'outbound' } });
    expect(out.state).toBe('accepted');
    expect(out.providerMessageId).toMatch(/^mid\.live\./);
    // Ikkala yo'nalish ham haqiqiy sinovdan o'tdi: endi (va faqat endi) tayyor
    const ready = await p().integrationConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(ready).toMatchObject({ health: 'ok', healthReason: null });
    expect((await admin.get('/api/v1/integrations/instagram/status')).body.connections[0].state).toBe('ready');
  });

  it('token yangilash: 14 kun ichida tugaydigan uzun token yangilanadi; muvaffaqiyatsiz bo‘lsa ulanish ko‘rinadigan sabab bilan degraded', async () => {
    const conn = await p().integrationConnection.findFirstOrThrow({ where: { provider: 'META_DIRECT', accountId: IG_ID } });
    // 24 soatdan eski va 5 kundan keyin tugaydigan token
    const { decryptSecret, encryptSecret } = await import('@crm/database');
    const creds = JSON.parse(decryptSecret(conn.credentialsEnc!, core.deps.encryptionKey));
    await p().integrationConnection.update({ where: { id: conn.id }, data: { expiresAt: new Date(Date.now() + 5 * 86_400_000), credentialsEnc: encryptSecret(JSON.stringify({ ...creds, issuedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }), core.deps.encryptionKey) } });
    const r = await core.instagram.refreshDue();
    expect(r).toEqual({ refreshed: 1, failed: 0 });
    const after = await p().integrationConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(JSON.parse(decryptSecret(after.credentialsEnc!, core.deps.encryptionKey)).accessToken).toBe('LONG_TOKEN_2');
    expect(after.expiresAt!.getTime() - Date.now()).toBeGreaterThan(59 * 86_400_000);
  });

  it('deauthorize callback: imzolangan so‘rov ulanishni to‘xtatadi (tarix saqlanadi); imzosiz rad etiladi', async () => {
    const { createHmac } = await import('node:crypto');
    const payload = Buffer.from(JSON.stringify({ user_id: IG_ID, algorithm: 'HMAC-SHA256' })).toString('base64url');
    const sig = createHmac('sha256', APP_SECRET).update(payload).digest('base64url');
    const igSig = createHmac('sha256', IG_SECRET).update(payload).digest('base64url');
    expect((await request(app.getHttpServer()).post('/webhooks/meta/deauthorize').type('form').send({ signed_request: `${igSig}.${payload}` })).status).toBe(401);
    const bad = await request(app.getHttpServer()).post('/webhooks/meta/deauthorize').type('form').send({ signed_request: `${sig}.${payload}x` });
    expect(bad.status).toBe(401);
    const ok = await request(app.getHttpServer()).post('/webhooks/meta/deauthorize').type('form').send({ signed_request: `${sig}.${payload}` });
    expect(ok.status).toBe(200);
    const conn = await p().integrationConnection.findFirstOrThrow({ where: { provider: 'META_DIRECT', accountId: IG_ID } });
    expect(conn).toMatchObject({ health: 'disconnected', healthReason: 'deauthorized_by_account_owner', credentialsEnc: null });
    expect(await p().conversation.count({ where: { connectionId: conn.id } })).toBeGreaterThan(0); // tarix saqlangan
    expect((await subscribe({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': 'abc' })).status).toBe(403);
  });
});
