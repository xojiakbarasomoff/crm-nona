import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { encryptSecret } from '@crm/database';
import { DEMO_STATUS_IDS, type DemoAmoRestClient } from '@crm/integrations';
import { amoCrmSignal, companyId, drain, login, makeApp, makeCore, newLead, sendLeadAds, userId } from './helpers';

let core: Core;
let app: INestApplication;
const p = () => core.deps.prisma;
const amo = () => core.deps.adapters.amoRest({ id: '', accountDomain: null, accountId: '' }) as DemoAmoRestClient;
const redis = () => core.deps.redis;

beforeAll(async () => {
  core = makeCore();
  app = await makeApp(core);
});
afterAll(async () => {
  await app.close();
  await core.close();
});

describe('assignment (AC10, AC11)', () => {
  it('AC10: 100 parallel new leads over 3 equal managers differ by at most 1', async () => {
    const managers = await p().user.findMany({ where: { role: 'MANAGER', status: 'active', email: { endsWith: '@demo.local' } } });
    const pool = await p().managerPool.findFirstOrThrow({ where: { isDefault: true } });
    // Make schedules always-on for the test so time of day does not matter.
    await p().managerPoolMember.updateMany({ where: { poolId: pool.id }, data: { schedule: null as never, available: true } });
    const memberIds = (await p().managerPoolMember.findMany({ where: { poolId: pool.id } })).map((m) => m.userId);
    const before = await p().lead.groupBy({ by: ['ownerId'], where: { assignmentReason: 'round_robin' }, _count: true });
    const batch = `${Date.now()}`;
    await Promise.all(Array.from({ length: 100 }, (_, i) => sendLeadAds(app, core, { fullName: `RR ${batch} ${i}`, phone: `+99893${String(1_000_000 + i).padStart(7, '0')}${batch.slice(-1)}`.slice(0, 13), platform: 'ig' })));
    const ids = await core.processing.claimInboxBatch(200);
    // 10 concurrent processors compete for the pool lock.
    const chunks = Array.from({ length: 10 }, (_, k) => ids.filter((_, i) => i % 10 === k));
    await Promise.all(chunks.map(async (c) => { for (const id of c) await core.processing.processInbox(id); }));
    const after = await p().lead.groupBy({ by: ['ownerId'], where: { assignmentReason: 'round_robin' }, _count: true });
    const delta = memberIds.map((uid) => (after.find((a) => a.ownerId === uid)?._count ?? 0) - (before.find((b) => b.ownerId === uid)?._count ?? 0));
    expect(delta.reduce((a, b) => a + b, 0)).toBe(100);
    expect(Math.max(...delta) - Math.min(...delta)).toBeLessThanOrEqual(1);
    expect(managers.length).toBe(3);
    await drain(core);
  });

  it('AC11: nobody available → duty user with explicit reason and head signal; queue when no duty', async () => {
    const pool = await p().managerPool.findFirstOrThrow({ where: { isDefault: true } });
    await p().managerPoolMember.updateMany({ where: { poolId: pool.id }, data: { available: false } });
    try {
      const lead = await newLead(app, core);
      expect(lead.assignmentReason).toBe('duty_fallback');
      expect(lead.ownerId).toBe(await userId(core, 'rahbar@demo.local'));
      expect(await p().notification.count({ where: { kind: 'lead_duty_fallback' } })).toBeGreaterThan(0);

      await p().company.update({ where: { id: companyId }, data: { settings: { amoRequiresResponsible: false } } });
      const { leadgenId } = await sendLeadAds(app, core, { fullName: 'Navbat', phone: '+998935550001', platform: 'ig' });
      await drain(core);
      const inq = await p().inquiry.findFirstOrThrow({ where: { providerEventKey: `meta_leads:${leadgenId}` } });
      const queued = await p().lead.findUniqueOrThrow({ where: { id: inq.leadId! } });
      expect(queued).toMatchObject({ ownerId: null, assignmentReason: 'awaiting_assignment' });
      expect(await p().notification.count({ where: { kind: 'lead_awaiting_assignment' } })).toBeGreaterThan(0);
    } finally {
      await p().company.update({ where: { id: companyId }, data: { settings: { amoRequiresResponsible: true } } });
      await p().managerPoolMember.updateMany({ where: { poolId: pool.id }, data: { available: true } });
    }
  });
});

describe('amoCRM as source of truth (AC13, AC14, AC15, AC30)', () => {
  it('AC13: owner changed natively in amoCRM → local access, order, reminders, tasks follow; history keeps author', async () => {
    const lead = await newLead(app, core);
    const oldOwner = lead.ownerId!;
    const head = await login(app, 'rahbar@demo.local');
    const order = await head.post('/api/v1/orders', { leadId: lead.id, agreedAmount: '500.00', currency: 'USD' });
    const newOwner = await p().user.findFirstOrThrow({ where: { role: 'MANAGER', id: { not: oldOwner } } });
    await amo().simulateNativeEdit(lead.amoLeadId!, { responsibleUserId: newOwner.amoUserId! }, new Date(Date.now() + 1000));
    await amoCrmSignal(app, core, lead.amoLeadId!);
    await drain(core);
    const after = await p().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.ownerId).toBe(newOwner.id);
    expect((await p().order.findUniqueOrThrow({ where: { id: order.body.id } })).ownerId).toBe(newOwner.id);
    const ev = await p().leadEvent.findFirstOrThrow({ where: { leadId: lead.id, kind: 'owner_change' } });
    expect(ev).toMatchObject({ oldOwnerId: oldOwner, newOwnerId: newOwner.id, origin: 'amocrm' });
    const created = await p().leadEvent.findFirstOrThrow({ where: { leadId: lead.id, kind: 'created' } });
    expect(created.newOwnerId).toBe(oldOwner); // historical authorship unchanged
    const task = await p().crmTask.findFirstOrThrow({ where: { entityId: lead.id, kind: 'first_contact' } });
    expect(task.responsibleUserId).toBe(newOwner.id);
  });

  it('AC14: native status without required data → anomaly + correction task, not reverted', async () => {
    const lead = await newLead(app, core);
    await amo().simulateNativeEdit(lead.amoLeadId!, { statusId: DEMO_STATUS_IDS.QUALIFIED }, new Date(Date.now() + 1000));
    await amoCrmSignal(app, core, lead.amoLeadId!);
    await drain(core);
    const after = await p().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.stage).toBe('QUALIFIED');
    expect((after.anomaly as { missing: string[] }).missing).toContain('requirements.destination');
    expect(await p().crmTask.count({ where: { entityId: lead.id, kind: 'anomaly_fix' } })).toBe(1);
  });

  it('AC15: WON + duplicate webhooks → one active order, counted once', async () => {
    const lead = await newLead(app, core);
    const when = new Date(Date.now() + 2000);
    await amo().simulateNativeEdit(lead.amoLeadId!, { statusId: DEMO_STATUS_IDS.WON }, when);
    await Promise.all(Array.from({ length: 5 }, () => amoCrmSignal(app, core, lead.amoLeadId!, when.getTime())));
    await amoCrmSignal(app, core, lead.amoLeadId!, when.getTime() + 1);
    await drain(core);
    const orders = await p().order.findMany({ where: { leadId: lead.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0]!.fulfillmentState).toBe('draft');
    expect(orders[0]!.orderNo).toMatch(/^TR-\d{4}-\d{6}$/);
    const after = await p().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.firstWonAt?.toISOString()).toBe(when.toISOString());
    expect(await p().leadEvent.count({ where: { leadId: lead.id, newStage: 'WON' } })).toBe(1);
  });

  it('AC30: an older snapshot never rolls back the newer state', async () => {
    const lead = await newLead(app, core);
    const t1 = new Date(Date.now() + 5000);
    await amo().simulateNativeEdit(lead.amoLeadId!, { statusId: DEMO_STATUS_IDS.CONTACTED }, t1);
    await amoCrmSignal(app, core, lead.amoLeadId!);
    await drain(core);
    const snap = (await amo().getLead(lead.amoLeadId!))!;
    const stale = { ...snap, statusId: DEMO_STATUS_IDS.NEW!, updatedAt: new Date(t1.getTime() - 60_000) };
    const res = await p().$transaction((tx) => core.leads.applyRemoteSnapshot(tx, companyId, stale, { origin: 'amocrm' }));
    expect(res).toMatchObject({ applied: false, reason: 'stale' });
    expect((await p().lead.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe('CONTACTED');
  });

  it('web stage change is applied only after amoCRM confirms; missing fields → 422', async () => {
    const lead = await newLead(app, core);
    const owner = await p().user.findUniqueOrThrow({ where: { id: lead.ownerId! } });
    const s = await login(app, owner.email);
    const bad = await s.patch(`/api/v1/leads/${lead.id}/stage`, { version: lead.version, stage: 'CONTACTED' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.field_errors).toHaveProperty('contact_outcome');
    const upd = await s.patch(`/api/v1/leads/${lead.id}`, { version: lead.version, contactOutcome: 'Qo‘ng‘iroq qilindi' });
    const r = await s.patch(`/api/v1/leads/${lead.id}/stage`, { version: upd.body.version, stage: 'CONTACTED' });
    expect(r.status).toBe(202);
    expect(r.body.stage).toBe('NEW');
    expect(r.body.syncState).toBe('pending');
    await drain(core);
    const after = await p().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after).toMatchObject({ stage: 'CONTACTED', syncState: 'synced', pendingChange: null });
    expect(await p().leadEvent.count({ where: { leadId: lead.id, newStage: 'CONTACTED', origin: 'local', actorId: owner.id } })).toBe(1);
    // Stale version → 409
    expect((await s.patch(`/api/v1/leads/${lead.id}`, { version: 1, contactOutcome: 'x' })).status).toBe(409);
  });

  it('amoCRM deletion tombstones the lead and is never recreated', async () => {
    const lead = await newLead(app, core);
    await amo().simulateNativeEdit(lead.amoLeadId!, { deleted: true }, new Date(Date.now() + 1000));
    await amoCrmSignal(app, core, lead.amoLeadId!);
    await drain(core);
    const after = await p().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(await p().outboxOperation.count({ where: { action: 'lead.create', payload: { path: ['leadId'], equals: lead.id } } })).toBe(1);
  });
});

describe('resilience (AC27, AC29, AC28, AC34)', () => {
  it('AC27: 429 and 5xx are retried with backoff and the backlog is visible', async () => {
    await core.deps.adapters.demoStore!.injectFailure('amo', 'rate_limited');
    await core.deps.adapters.demoStore!.injectFailure('amo', 'server_error');
    const { leadgenId } = await sendLeadAds(app, core, { fullName: '429 Mijoz', phone: '+998937770001', platform: 'ig' });
    await drain(core);
    const inq = await p().inquiry.findFirstOrThrow({ where: { providerEventKey: `meta_leads:${leadgenId}` } });
    const op = await p().outboxOperation.findFirstOrThrow({ where: { operationKey: `lead.create:${inq.leadId}` } });
    expect(op.state).toBe('failed');
    expect(op.errorClass).toBe('rate_limited');
    const head = await login(app, 'rahbar@demo.local');
    const health = await head.get('/api/v1/integrations/health');
    expect(health.body.outbox.failed).toBeGreaterThanOrEqual(1);
    expect(health.body.metrics.provider_429).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 3; i++) {
      await p().outboxOperation.update({ where: { id: op.id }, data: { nextAttemptAt: new Date() } });
      await drain(core);
    }
    const done = await p().outboxOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(done.state).toBe('done');
    expect(done.attempts).toBe(3);
  });

  it('AC29: lead create timeout → reconciliation by operation id, no second lead in amoCRM', async () => {
    const createsBefore = Number((await redis().get('demo:amo:creates')) ?? 0);
    await core.deps.adapters.demoStore!.injectFailure('amo', 'timeout_after_create');
    const lead = await newLead(app, core);
    expect(lead.amoLeadId).not.toBeNull();
    const op = await p().outboxOperation.findFirstOrThrow({ where: { operationKey: `lead.create:${lead.id}` } });
    expect(op.state).toBe('done');
    expect((op.result as { reconciled?: boolean }).reconciled).toBe(true);
    expect(Number(await redis().get('demo:amo:creates')) - createsBefore).toBe(1);
  });

  it('AC29: unknown outcome without a match → unknown + operator signal, no blind retry', async () => {
    const createsBefore = Number((await redis().get('demo:amo:creates')) ?? 0);
    await core.deps.adapters.demoStore!.injectFailure('amo', 'timeout_before');
    // findLeadByOperationId after the timeout also fails → cannot confirm.
    await core.deps.adapters.demoStore!.injectFailure('amo', 'server_error');
    const { leadgenId } = await sendLeadAds(app, core, { fullName: 'Noma’lum', phone: '+998937770002', platform: 'ig' });
    await drain(core);
    const inq = await p().inquiry.findFirstOrThrow({ where: { providerEventKey: `meta_leads:${leadgenId}` } });
    const op = await p().outboxOperation.findFirstOrThrow({ where: { operationKey: `lead.create:${inq.leadId}` } });
    expect(op.state).toBe('unknown');
    expect((await p().lead.findUniqueOrThrow({ where: { id: inq.leadId! } })).syncState).toBe('unknown');
    expect(Number(await redis().get('demo:amo:creates')) - createsBefore).toBe(0);
    expect(await p().notification.count({ where: { kind: 'outbox_unknown' } })).toBeGreaterThan(0);
    // Operator replay reconciles first, then creates exactly once.
    const admin = await login(app, 'admin@demo.local');
    expect((await admin.post(`/api/v1/integrations/replay/${op.id}`)).status).toBe(202);
    await drain(core);
    expect((await p().outboxOperation.findUniqueOrThrow({ where: { id: op.id } })).state).toBe('done');
    expect(Number(await redis().get('demo:amo:creates')) - createsBefore).toBe(1);
  });

  it('AC28: parallel refresh performs one token exchange and stores one new pair', async () => {
    let calls = 0;
    const fakeFetch = (async (url: string) => {
      calls++;
      await new Promise((r) => setTimeout(r, 150));
      expect(url).toBe('https://demo-turizm.amocrm.ru/oauth2/access_token');
      return new Response(JSON.stringify({ token_type: 'Bearer', expires_in: 86400, access_token: `new-access-${calls}`, refresh_token: `new-refresh-${calls}` }), { status: 200 });
    }) as never;
    const c2 = makeCore({ fetchImpl: fakeFetch });
    const conn = await c2.deps.prisma.integrationConnection.findFirstOrThrow({ where: { provider: 'AMOCRM_REST' } });
    await c2.deps.prisma.integrationConnection.update({
      where: { id: conn.id },
      data: { credentialsEnc: encryptSecret(JSON.stringify({ accessToken: 'old', refreshToken: 'old-refresh', tokenType: 'Bearer' }), c2.deps.encryptionKey), expiresAt: new Date(Date.now() - 1000) },
    });
    const providers = Array.from({ length: 8 }, () => c2.oauth.tokenProvider(conn.id));
    const tokens = await Promise.all(providers.map((tp) => tp.getAccessToken()));
    expect(calls).toBe(1);
    expect(new Set(tokens)).toEqual(new Set(['new-access-1']));
    await c2.close();
  });

  it('AC34: disconnected integration pauses work, admin sees it, history stays; reconnect resumes', async () => {
    const admin = await login(app, 'admin@demo.local');
    const conn = await p().integrationConnection.findFirstOrThrow({ where: { provider: 'AMOCRM_REST' } });
    const leadsBefore = await p().lead.count();
    expect((await admin.post(`/api/v1/integrations/${conn.id}/disconnect`)).status).toBe(200);
    try {
      const { leadgenId } = await sendLeadAds(app, core, { fullName: 'Uzilgan', phone: '+998937770003', platform: 'ig' });
      await drain(core);
      const inq = await p().inquiry.findFirstOrThrow({ where: { providerEventKey: `meta_leads:${leadgenId}` } });
      const op = await p().outboxOperation.findFirstOrThrow({ where: { operationKey: `lead.create:${inq.leadId}` } });
      expect(op.state).toBe('paused');
      const health = await admin.get('/api/v1/integrations/health');
      expect(health.body.connections.find((c: { id: string }) => c.id === conn.id).health).toBe('disconnected');
      expect(await p().lead.count()).toBe(leadsBefore + 1);
      expect(await p().auditLog.count({ where: { entityId: conn.id, action: 'disconnected' } })).toBe(1);
      // Reconnect (demo: restore connection + resume paused ops as the OAuth callback does).
      await p().integrationConnection.update({ where: { id: conn.id }, data: { health: 'ok', disconnectedAt: null, healthReason: null } });
      await p().outboxOperation.updateMany({ where: { state: 'paused', target: 'amocrm' }, data: { state: 'pending', nextAttemptAt: new Date() } });
      await drain(core);
      expect((await p().outboxOperation.findUniqueOrThrow({ where: { id: op.id } })).state).toBe('done');
    } finally {
      await p().integrationConnection.update({ where: { id: conn.id }, data: { health: 'ok', disconnectedAt: null, healthReason: null } });
    }
  });
});
