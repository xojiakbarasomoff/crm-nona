import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEAD_ADS_SCOPES, signMetaBody } from '@crm/integrations';
import type { Core } from '../../apps/api/src/core';
import { alwaysOnDuty, drain, login, makeApp, makeCore, type Session } from './helpers';

const PAGE = '991001001';
const FORM = '991002002';
const APP = '991003003';
const SECRET = 'lead-ads-test-secret';
let grantAll = true;
let subscribed = false;
const leads = new Map<string, Record<string, unknown>>();
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
async function fetcher(input: string, init?: RequestInit) {
  const u = new URL(input);
  if (u.pathname.endsWith('/oauth/access_token')) return json({ access_token: u.searchParams.has('code') ? 'short-test-token' : 'long-test-token' });
  if (u.pathname.endsWith('/me/permissions')) return json({ data: LEAD_ADS_SCOPES.filter(s => grantAll || s !== 'leads_retrieval').map(permission => ({ permission, status: 'granted' })) });
  if (u.pathname.endsWith('/me/accounts')) return json({ data: [{ id: PAGE, name: 'NONA Travel test', access_token: 'page-test-token', instagram_business_account: { username: 'nonatravel.uz' } }] });
  if (u.pathname.endsWith(`/${PAGE}/leadgen_forms`)) return json({ data: [{ id: FORM, name: 'Istanbul test', status: 'ACTIVE' }] });
  if (u.pathname.endsWith(`/${PAGE}/subscribed_apps`)) {
    if (init?.method === 'POST') { subscribed = true; return json({ success: true }); }
    return json({ data: subscribed ? [{ id: APP, subscribed_fields: ['leadgen'] }] : [] });
  }
  if (u.pathname.endsWith(`/${FORM}/leads`)) return json({ data: [] });
  const id = u.pathname.split('/').at(-1)!;
  if (leads.has(id)) { expect(init?.headers).toMatchObject({ Authorization: 'Bearer page-test-token' }); return json(leads.get(id)); }
  throw new Error(`Unexpected Graph request ${u.pathname}`);
}

let core: Core;
let app: INestApplication;
let admin: Session;
let manager: Session;
let connectionId: string;

beforeAll(async () => {
  core = makeCore({ fetchImpl: fetcher, env: { META_APP_ID: APP, META_APP_SECRET: SECRET, META_VERIFY_TOKEN: 'test-verify', META_GRAPH_VERSION: 'v23.0' } });
  await alwaysOnDuty(core);
  app = await makeApp(core);
  admin = await login(app, 'admin@demo.local');
  manager = await login(app, 'menejer.a@demo.local');
});
afterAll(async () => {
  if (connectionId) await core.deps.prisma.integrationConnection.update({ where: { id: connectionId }, data: { disconnectedAt: new Date(), credentialsEnc: null, health: 'disconnected' } });
  await app.close(); await core.close();
});

async function authorize(session = admin) {
  const start = await session.post('/api/v1/integrations/lead-ads/oauth/start', {});
  expect(start.status).toBe(200);
  const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
  const url = `/api/v1/integrations/lead-ads/oauth/callback?code=test-code&state=${encodeURIComponent(state)}`;
  return { state, url, response: await session.get(url) };
}

describe('Lead Ads setup and signed webhook → visible CRM lead (local Graph fixtures)', () => {
  it('requires an admin; denies insufficient scopes and reused OAuth state', async () => {
    expect((await manager.get('/api/v1/integrations/lead-ads/status')).status).toBe(403);
    expect((await manager.post('/api/v1/integrations/lead-ads/oauth/start', {})).status).toBe(403);
    expect((await manager.post('/api/v1/integrations/lead-ads/connect', { pageId: PAGE, formIds: [FORM] })).status).toBe(403);
    grantAll = false;
    const denied = await authorize();
    grantAll = true;
    expect(denied.response.headers.location).toContain('LEAD_ADS_PERMISSION_MISSING');
    expect((await admin.get(denied.url)).headers.location).toContain('OAUTH_STATE_INVALID');
  });

  it('keeps Page tokens off the UI, validates form ownership and stores live credentials encrypted', async () => {
    const auth = await authorize();
    expect(auth.response.headers.location).toContain('lead_ads=select_page');
    expect((await admin.get(auth.url)).headers.location).toContain('OAUTH_STATE_INVALID');
    const status = await admin.get('/api/v1/integrations/lead-ads/status');
    expect(status.body.pendingPages).toEqual([{ id: PAGE, name: 'NONA Travel test', instagramUsername: 'nonatravel.uz' }]);
    expect(JSON.stringify(status.body)).not.toContain('test-token');
    expect((await admin.get('/api/v1/integrations/lead-ads/forms?pageId=123')).status).toBe(422);
    expect((await admin.get(`/api/v1/integrations/lead-ads/forms?pageId=${PAGE}`)).body.items[0].id).toBe(FORM);
    expect((await admin.post('/api/v1/integrations/lead-ads/connect', { pageId: PAGE, formIds: ['123'] })).status).toBe(422);
    const connected = await admin.post('/api/v1/integrations/lead-ads/connect', { pageId: PAGE, formIds: [FORM] });
    expect(connected.status).toBe(200);
    connectionId = connected.body.id;
    const c = await core.deps.prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(c).toMatchObject({ provider: 'META_LEADS', mode: 'live', health: 'degraded', healthReason: 'awaiting_lead_ads_test' });
    expect(c.credentialsEnc).not.toContain('page-test-token');
    expect((await admin.get('/api/v1/integrations/lead-ads/status')).body.connections.find((x: { id: string }) => x.id === c.id).state).toBe('awaiting_test');
    await drain(core);
    expect((await core.deps.prisma.outboxOperation.findFirstOrThrow({ where: { operationKey: { startsWith: `meta.backfill:${c.id}:` } } })).state).toBe('done');
  });

  it('imports a real-mode event through Graph in demo runtime, exposes form answers, and deduplicates retries', async () => {
    const id = `lead_${randomUUID()}`;
    const phone = '+99897' + Date.now().toString().slice(-7);
    leads.set(id, { id, form_id: FORM, platform: 'ig', created_time: new Date().toISOString(), field_data: [{ name: 'full_name', values: ['Target test customer'] }, { name: 'phone_number', values: [phone] }, { name: 'destination', values: ['Istanbul'] }] });
    const body = Buffer.from(JSON.stringify({ object: 'page', entry: [{ id: PAGE, changes: [{ field: 'leadgen', value: { page_id: PAGE, form_id: FORM, leadgen_id: id, created_time: Math.floor(Date.now() / 1000) } }] }] }));
    const deliver = (signature = signMetaBody(body, SECRET)) => request(app.getHttpServer()).post('/webhooks/meta').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signature).send(body.toString());
    expect((await deliver('sha256=bad')).status).toBe(401);
    expect((await deliver()).status).toBe(200);
    await drain(core);
    const inquiry = await core.deps.prisma.inquiry.findFirstOrThrow({ where: { providerEventKey: `meta_leads:${id}` } });
    expect(inquiry).toMatchObject({ channel: 'instagram_lead_ads', processingState: 'linked', formData: { full_name: 'Target test customer', phone_number: phone, destination: 'Istanbul' } });
    expect(inquiry.leadId).toBeTruthy();
    const card = await admin.get(`/api/v1/leads/${inquiry.leadId}`);
    expect(card.status).toBe(200);
    expect(JSON.stringify(card.body)).toContain('Target test customer');
    expect(card.body.inquiries[0].formData.destination).toBe('Istanbul');
    expect(card.body.lead.requirements.destination).toBe('Istanbul');
    await deliver(); await drain(core);
    expect(await core.deps.prisma.inquiry.count({ where: { providerEventKey: `meta_leads:${id}` } })).toBe(1);
    const status = (await admin.get('/api/v1/integrations/lead-ads/status')).body;
    expect(status.connections.find((x: { id: string }) => x.id === connectionId)).toMatchObject({ state: 'ready', webhookSubscribed: true });
    expect((await admin.get('/api/v1/me')).body.liveStatus.leadAdsVerified).toBe(true);
  });

  it('rejects OAuth state from another session and never marks a backfill as webhook verification', async () => {
    const start = await admin.post('/api/v1/integrations/lead-ads/oauth/start', {});
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    const second = await login(app, 'admin@demo.local');
    expect((await second.get(`/api/v1/integrations/lead-ads/oauth/callback?code=x&state=${state}`)).headers.location).toContain('OAUTH_STATE_INVALID');
    const { markLeadAdsImported } = await import('../../apps/api/src/core/services/lead-ads.service');
    await core.deps.prisma.integrationConnection.update({ where: { id: connectionId }, data: { health: 'degraded', healthReason: 'awaiting_lead_ads_test', settings: { formIds: [FORM], webhookSubscribed: true } } });
    await markLeadAdsImported(core.deps, connectionId, 'backfill:form');
    expect((await admin.get('/api/v1/integrations/lead-ads/status')).body.connections.find((x: { id: string }) => x.id === connectionId).state).toBe('awaiting_test');
  });
});
