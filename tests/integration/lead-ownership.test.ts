import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { WORK_SCHEDULE } from '../../packages/database/src/seed';
import { companyId, drain, login, makeApp, makeCore, newLead, sendLeadAds, userId } from './helpers';

let core: Core;
let app: INestApplication;
const p = () => core.deps.prisma;

beforeAll(async () => {
  core = makeCore();
  app = await makeApp(core);
});
afterAll(async () => {
  // AC10 jadvalni 24/7 qiladi; boshqa fayllar (compliance: ish kuni/yakshanba) seed jadvaliga tayanadi — qaytaramiz.
  await p().managerPoolMember.updateMany({ data: { schedule: WORK_SCHEDULE as never, available: true } });
  await app.close();
  await core.close();
});

describe('assignment (AC10, AC11)', () => {
  it('AC10: 100 parallel new leads over 3 equal managers differ by at most 1', async () => {
    const managers = await p().user.findMany({ where: { role: 'MANAGER', status: 'active', email: { endsWith: '@demo.local' } } });
    const pool = await p().managerPool.findFirstOrThrow({ where: { isDefault: true } });
    await p().managerPoolMember.updateMany({ where: { poolId: pool.id }, data: { schedule: null as never, available: true } });
    // Faqat faol xodimlar teng taqsimlanadi (boshqa fayllarda yaratilib bloklangan menejer navbatda qolishi mumkin).
    const memberIds = (await p().managerPoolMember.findMany({ where: { poolId: pool.id } })).map((m) => m.userId).filter((uid) => managers.some((u) => u.id === uid));
    const before = await p().lead.groupBy({ by: ['ownerId'], where: { assignmentReason: 'round_robin' }, _count: true });
    const batch = `${Date.now()}`;
    await Promise.all(Array.from({ length: 100 }, (_, i) => sendLeadAds(app, core, { fullName: `RR ${batch} ${i}`, phone: `+99893${String(1_000_000 + i).padStart(7, '0')}${batch.slice(-1)}`.slice(0, 13), platform: 'ig' })));
    const ids = await core.processing.claimInboxBatch(200);
    const chunks = Array.from({ length: 10 }, (_, k) => ids.filter((_, i) => i % 10 === k));
    const outcomes: string[] = [];
    await Promise.all(chunks.map(async (c) => { for (const id of c) outcomes.push(await core.processing.processInbox(id)); }));
    const failed = await p().webhookInbox.findMany({ where: { id: { in: ids }, state: { notIn: ['done'] } }, select: { state: true, lastError: true } });
    expect(failed).toEqual([]);
    expect(outcomes.every((o) => o === 'processed')).toBe(true);
    const after = await p().lead.groupBy({ by: ['ownerId'], where: { assignmentReason: 'round_robin' }, _count: true });
    const delta = memberIds.map((uid) => (after.find((a) => a.ownerId === uid)?._count ?? 0) - (before.find((b) => b.ownerId === uid)?._count ?? 0));
    expect(delta.reduce((a, b) => a + b, 0)).toBe(100);
    expect(Math.max(...delta) - Math.min(...delta)).toBeLessThanOrEqual(1);
    expect(managers.length).toBe(3);
    await drain(core);
  }, 180_000);

  it('AC11: nobody available → duty administrator with explicit reason and signal; queue when no duty user', async () => {
    const pool = await p().managerPool.findFirstOrThrow({ where: { isDefault: true } });
    await p().managerPoolMember.updateMany({ where: { poolId: pool.id }, data: { available: false } });
    const company = await p().company.findUniqueOrThrow({ where: { id: companyId } });
    try {
      const lead = await newLead(app, core);
      expect(lead.assignmentReason).toBe('duty_fallback');
      expect(lead.ownerId).toBe(await userId(core, 'admin2@demo.local'));
      expect(await p().notification.count({ where: { kind: 'lead_duty_fallback' } })).toBeGreaterThan(0);

      await p().company.update({ where: { id: companyId }, data: { dutyUserId: null } });
      const { leadgenId } = await sendLeadAds(app, core, { fullName: 'Navbat', phone: '+998935550001', platform: 'ig' });
      await drain(core);
      const inq = await p().inquiry.findFirstOrThrow({ where: { providerEventKey: `meta_leads:${leadgenId}` } });
      const queued = await p().lead.findUniqueOrThrow({ where: { id: inq.leadId! } });
      expect(queued).toMatchObject({ ownerId: null, assignmentReason: 'awaiting_assignment' });
      expect(await p().notification.count({ where: { kind: 'lead_awaiting_assignment' } })).toBeGreaterThan(0);
    } finally {
      await p().company.update({ where: { id: companyId }, data: { dutyUserId: company.dutyUserId } });
      await p().managerPoolMember.updateMany({ where: { poolId: pool.id }, data: { available: true } });
    }
  });
});

describe('local lead ownership (no external CRM)', () => {
  it('new lead gets a first_contact task for the assigned owner immediately', async () => {
    const lead = await newLead(app, core);
    const task = await p().crmTask.findFirstOrThrow({ where: { entityId: lead.id, kind: 'first_contact' } });
    expect(task).toMatchObject({ responsibleUserId: lead.ownerId, state: 'pending' });
    expect(lead.syncState).toBe('local_only');
    // nothing is queued for a removed integration
    expect(await p().outboxOperation.count({ where: { target: { in: ['amocrm', 'amocrm_chats'] }, payload: { path: ['leadId'], equals: lead.id } } })).toBe(0);
  });

  it('reassign is applied immediately: orders, reminders and tasks follow; history keeps the author', async () => {
    const lead = await newLead(app, core);
    const oldOwner = lead.ownerId!;
    const admin = await login(app, 'admin@demo.local');
    const order = await admin.post('/api/v1/orders', { leadId: lead.id, agreedAmount: '500.00', currency: 'USD' });
    const newOwner = await p().user.findFirstOrThrow({ where: { role: 'MANAGER', id: { not: oldOwner } } });
    const r = await admin.patch(`/api/v1/leads/${lead.id}/assignee`, { userId: newOwner.id, reason: 'Test' });
    expect(r.status).toBe(200);
    expect(r.body.ownerId).toBe(newOwner.id);
    expect((await p().order.findUniqueOrThrow({ where: { id: order.body.id } })).ownerId).toBe(newOwner.id);
    const ev = await p().leadEvent.findFirstOrThrow({ where: { leadId: lead.id, kind: 'owner_change' } });
    expect(ev).toMatchObject({ oldOwnerId: oldOwner, newOwnerId: newOwner.id, origin: 'local' });
    const created = await p().leadEvent.findFirstOrThrow({ where: { leadId: lead.id, kind: 'created' } });
    expect(created.newOwnerId).toBe(oldOwner);
    expect((await p().crmTask.findFirstOrThrow({ where: { entityId: lead.id, kind: 'first_contact' } })).responsibleUserId).toBe(newOwner.id);
    expect(await p().notification.count({ where: { userId: newOwner.id, kind: 'lead_assigned', link: `/leads/${lead.id}` } })).toBeGreaterThan(0);
    // a manager cannot reassign
    const mgr = await login(app, 'menejer.a@demo.local');
    expect((await mgr.patch(`/api/v1/leads/${lead.id}/assignee`, { userId: newOwner.id, reason: 'x' })).status).toBeGreaterThanOrEqual(403);
  });

  it('stage change is applied at once (200); missing fields → 422; stale version → 409', async () => {
    const lead = await newLead(app, core);
    const owner = await p().user.findUniqueOrThrow({ where: { id: lead.ownerId! } });
    const s = await login(app, owner.email);
    const bad = await s.patch(`/api/v1/leads/${lead.id}/stage`, { version: lead.version, stage: 'CONTACTED' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.field_errors).toHaveProperty('contact_outcome');
    const upd = await s.patch(`/api/v1/leads/${lead.id}`, { version: lead.version, contactOutcome: 'Qo‘ng‘iroq qilindi' });
    const r = await s.patch(`/api/v1/leads/${lead.id}/stage`, { version: upd.body.version, stage: 'CONTACTED' });
    expect(r.status).toBe(200);
    expect(r.body.stage).toBe('CONTACTED');
    expect(await p().leadEvent.count({ where: { leadId: lead.id, newStage: 'CONTACTED', origin: 'local', actorId: owner.id } })).toBe(1);
    expect((await s.patch(`/api/v1/leads/${lead.id}`, { version: 1, contactOutcome: 'x' })).status).toBe(409);
  });

  it('LOST cancels open sales tasks; reopen needs a reason; one active order per lead', async () => {
    const lead = await newLead(app, core);
    const admin = await login(app, 'admin@demo.local');
    const patch = await admin.patch(`/api/v1/leads/${lead.id}`, {
      version: lead.version,
      contactOutcome: 'ok',
      serviceType: 'avia',
      requirements: { destination: 'IST', dateFrom: '2027-01-10', adults: 1, budgetState: 'known' },
      offerPrepDueAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(patch.status).toBe(200);
    // go straight to LOST (always allowed with a reason code)
    const lost = await admin.patch(`/api/v1/leads/${lead.id}`, { version: patch.body.version, lostReasonCode: 'price' });
    const toLost = await admin.patch(`/api/v1/leads/${lead.id}/stage`, { version: lost.body.version, stage: 'LOST' });
    expect(toLost.status).toBe(200);
    expect((await p().crmTask.findFirstOrThrow({ where: { entityId: lead.id, kind: 'first_contact' } })).state).toBe('cancelled');
    expect((await admin.post(`/api/v1/leads/${lead.id}/reopen`, { reason: '' })).status).toBe(422);
    const reopened = await admin.post(`/api/v1/leads/${lead.id}/reopen`, { reason: 'Mijoz qaytdi' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.stage).toBe('CONTACTED');
    expect(await p().leadEvent.count({ where: { leadId: lead.id, kind: 'reopened' } })).toBe(1);
    // an order for a won lead is created once even if requested twice
    const a = await admin.post('/api/v1/orders', { leadId: lead.id });
    const b = await admin.post('/api/v1/orders', { leadId: lead.id });
    expect(a.status).toBe(201);
    expect(b.status).toBe(409);
    expect(await p().order.count({ where: { leadId: lead.id } })).toBe(1);
  });

  it('blocking a user moves their open leads to the successor immediately', async () => {
    const lead = await newLead(app, core);
    const owner = await p().user.findUniqueOrThrow({ where: { id: lead.ownerId! } });
    const admin = await login(app, 'admin@demo.local');
    const successor = await userId(core, 'admin2@demo.local');
    const r = await admin.post(`/api/v1/users/${owner.id}/block`, { successorId: successor });
    expect(r.status).toBe(200);
    expect((await p().lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerId).toBe(successor);
    expect((await p().user.findUniqueOrThrow({ where: { id: owner.id } })).status).toBe('blocked');
    // restore for other tests
    await p().user.update({ where: { id: owner.id }, data: { status: 'active', blockedAt: null } });
  });

  it('legacy amoCRM outbox rows are closed without any call and are not shown as problems', async () => {
    const lead = await newLead(app, core);
    const op = await p().outboxOperation.create({ data: { companyId, operationKey: `legacy:${lead.id}`, target: 'amocrm', action: 'lead.stage', payload: { leadId: lead.id, stage: 'CONTACTED' }, correlationId: lead.id } });
    await drain(core);
    const done = await p().outboxOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(done.state).toBe('done');
    expect(done.result).toMatchObject({ skipped: 'amocrm_removed' });
    const admin = await login(app, 'admin@demo.local');
    const health = await admin.get('/api/v1/integrations/health');
    expect(health.status).toBe(200);
    expect(JSON.stringify(health.body)).not.toMatch(/amocrm/i);
    expect(health.body.connections.every((c: { provider: string }) => c.provider.startsWith('META'))).toBe(true);
  });
});
