import type { INestApplication } from '@nestjs/common';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { drain, login, makeApp, makeCore, markWon, newLead, TestClock, type Session } from './helpers';

const clock = new TestClock();
let core: Core;
let app: INestApplication;
const p = () => core.deps.prisma;

beforeAll(async () => {
  core = makeCore({ clock });
  app = await makeApp(core);
});
afterAll(async () => {
  await app.close();
  await core.close();
});

const tashkentLocal = (d: Date) => DateTime.fromJSDate(d, { zone: 'Asia/Tashkent' }).toFormat("yyyy-MM-dd'T'HH:mm");

async function ownerSession(leadOwnerId: string): Promise<Session> {
  const u = await p().user.findUniqueOrThrow({ where: { id: leadOwnerId } });
  return login(app, u.email);
}

async function confirmedOrder(departures: Date[]) {
  clock.real();
  const lead = await newLead(app, core);
  const s = await ownerSession(lead.ownerId!);
  const order = await s.post('/api/v1/orders', { leadId: lead.id, agreedAmount: '1200.00', currency: 'USD' });
  expect(order.status).toBe(201);
  const pax = await s.post(`/api/v1/orders/${order.body.id}/passengers`, { fullName: 'Ali Valiyev', type: 'adult' });
  const segIds: string[] = [];
  for (const [i, dep] of departures.entries()) {
    const seg = await s.post(`/api/v1/orders/${order.body.id}/segments`, {
      direction: i === 0 ? 'outbound' : i === departures.length - 1 ? 'return' : 'connection',
      originIata: ['TAS', 'IST', 'DXB'][i % 3],
      destinationIata: ['IST', 'DXB', 'TAS'][i % 3],
      marketingCarrier: 'TK',
      flightNumber: String(370 + i),
      departure: { local: tashkentLocal(dep), timezone: 'Asia/Tashkent' },
      departureTimezone: 'Asia/Tashkent',
      arrival: { local: tashkentLocal(new Date(dep.getTime() + 4 * 3600_000)), timezone: 'Asia/Tashkent' },
      arrivalTimezone: 'Asia/Tashkent',
      pnr: 'ABC123',
      passengerIds: [pax.body.id],
    });
    expect(seg.status).toBe(201);
    segIds.push(seg.body.id);
  }
  const confirmed = await s.patch(`/api/v1/orders/${order.body.id}`, { version: 1, fulfillmentState: 'confirmed', saleEvidence: 'Shartnoma #1' });
  expect(confirmed.status).toBe(200);
  return { lead, s, orderId: order.body.id as string, segIds };
}

async function tick() {
  const ids = await core.reminders.claimDue('test-worker', 200);
  for (const id of ids) await core.reminders.dispatch(id);
  await core.reminders.escalateOverdue();
  await core.reminders.markMissed();
  return ids.length;
}

describe('orders and money (AC15, AC31)', () => {
  it('one active order per lead; order number format; second create → 409', async () => {
    const lead = await newLead(app, core);
    const s = await ownerSession(lead.ownerId!);
    const a = await s.post('/api/v1/orders', { leadId: lead.id });
    expect(a.status).toBe(201);
    expect(a.body.orderNo).toMatch(/^TR-\d{4}-\d{6}$/);
    const b = await s.post('/api/v1/orders', { leadId: lead.id });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('ORDER_EXISTS');
  });

  it('offer versions are immutable once sent', async () => {
    const lead = await newLead(app, core);
    const s = await ownerSession(lead.ownerId!);
    const v1 = await s.post(`/api/v1/leads/${lead.id}/offers`, { content: 'Dubay 5 kun', amount: '900.00', currency: 'USD' });
    expect(v1.body).toMatchObject({ version: 1, amount: '900.00' });
    expect((await s.post(`/api/v1/offers/${v1.body.id}/sent`, { channel: 'instagram_direct' })).status).toBe(200);
    expect((await s.post(`/api/v1/offers/${v1.body.id}/sent`, { channel: 'phone' })).status).toBe(409);
    const v2 = await s.post(`/api/v1/leads/${lead.id}/offers`, { content: 'Dubay 5 kun (yangilangan)', amount: '950.50', currency: 'USD' });
    expect(v2.body.version).toBe(2);
    expect((await p().offer.findUniqueOrThrow({ where: { id: v1.body.id } })).amountMinor).toBe(90000n);
    expect((await s.post(`/api/v1/leads/${lead.id}/offers`, { content: 'x', amount: '1.234', currency: 'USD' })).status).toBe(422);
  });

  it('payments need Idempotency-Key; same key replays, different payload → 409; mixed currency is not auto-computed', async () => {
    const lead = await newLead(app, core);
    const s = await ownerSession(lead.ownerId!);
    const order = await s.post('/api/v1/orders', { leadId: lead.id, agreedAmount: '1000.00', currency: 'USD' });
    const url = `/api/v1/orders/${order.body.id}/payments`;
    const body = { kind: 'payment', amount: '400.00', currency: 'USD', receivedAt: new Date().toISOString(), method: 'cash' };
    expect((await s.post(url, body)).status).toBe(422);
    const r1 = await s.post(url, body, { 'Idempotency-Key': `pay-${order.body.id}-1` });
    expect(r1.status).toBe(201);
    expect(r1.body.order.paymentState).toBe('partial');
    const r2 = await s.post(url, body, { 'Idempotency-Key': `pay-${order.body.id}-1` });
    expect(r2.status).toBe(201);
    expect(await p().payment.count({ where: { orderId: order.body.id } })).toBe(1);
    expect((await s.post(url, { ...body, amount: '1.00' }, { 'Idempotency-Key': `pay-${order.body.id}-1` })).status).toBe(409);
    const r3 = await s.post(url, { ...body, amount: '600.00' }, { 'Idempotency-Key': `pay-${order.body.id}-2` });
    expect(r3.body.order.paymentState).toBe('paid');
    const r4 = await s.post(url, { ...body, amount: '100000.00', currency: 'UZS' }, { 'Idempotency-Key': `pay-${order.body.id}-3` });
    expect(r4.body.paymentStateNote).toContain('курс');
    expect(r4.body.order.paymentState).toBe('paid');
    expect((await s.post(url, { ...body, amount: '-5.00' }, { 'Idempotency-Key': `pay-${order.body.id}-4` })).status).toBe(422);
    await expect(p().payment.deleteMany({ where: { orderId: order.body.id } })).rejects.toThrow();
  });

  it('AC31: dashboard sums UZS and USD separately and never adds them', async () => {
    const ids: string[] = [];
    for (const [amount, currency] of [['100.00', 'USD'], ['1500000.00', 'UZS'], ['50.50', 'USD']] as const) {
      const lead = await newLead(app, core);
      const s = await ownerSession(lead.ownerId!);
      await s.post('/api/v1/orders', { leadId: lead.id, agreedAmount: amount, currency });
      await markWon(core, lead.id);
      ids.push(lead.id);
    }
    await drain(core);
    const head = await login(app, 'admin2@demo.local');
    const today = DateTime.now().setZone('Asia/Tashkent').toFormat('yyyy-MM-dd');
    const tomorrow = DateTime.now().setZone('Asia/Tashkent').plus({ days: 1 }).toFormat('yyyy-MM-dd');
    const dash = await head.get(`/api/v1/dashboard?from=${today}&to=${tomorrow}`);
    expect(dash.status).toBe(200);
    const sales = dash.body.periodMetrics.salesByCurrency;
    expect(Object.keys(sales).sort()).toEqual(['UZS', 'USD'].filter((c) => sales[c]).sort());
    expect(Number(sales.USD)).toBeGreaterThanOrEqual(150.5);
    expect(Number(sales.UZS)).toBeGreaterThanOrEqual(1500000);
    expect(dash.body.periodMetrics).not.toHaveProperty('salesTotal');
    expect(dash.body.periodMetrics.cohortConversion).toHaveProperty('display');
  });
});

describe('segments, time zones and milestones (AC16, AC17, AC18, AC19)', () => {
  it('AC17: ambiguous DST local time requires offset confirmation; IANA required', async () => {
    const lead = await newLead(app, core);
    const s = await ownerSession(lead.ownerId!);
    const order = await s.post('/api/v1/orders', { leadId: lead.id });
    const base = { direction: 'outbound', originIata: 'FRA', destinationIata: 'TAS', marketingCarrier: 'LH', flightNumber: '646', departureTimezone: 'Europe/Berlin', arrival: null, arrivalTimezone: 'Asia/Tashkent' };
    const amb = await s.post(`/api/v1/orders/${order.body.id}/segments`, { ...base, departure: { local: '2026-10-25T02:30', timezone: 'Europe/Berlin' } });
    expect(amb.status).toBe(422);
    expect(amb.body.error.code).toBe('AMBIGUOUS_LOCAL_TIME');
    expect(amb.body.error.details.options.map((o: { offsetMinutes: number }) => o.offsetMinutes)).toEqual([120, 60]);
    const ok = await s.post(`/api/v1/orders/${order.body.id}/segments`, { ...base, departure: { local: '2026-10-25T02:30', timezone: 'Europe/Berlin', confirmedOffsetMinutes: 60 } });
    expect(ok.status).toBe(201);
    expect(ok.body.departureAtUtc).toBe('2026-10-25T01:30:00.000Z');
    expect(ok.body.liveData).toBe(false);
    const fixed = await s.post(`/api/v1/orders/${order.body.id}/segments`, { ...base, departure: { local: '2026-11-01T10:00', timezone: 'UTC+4' }, departureTimezone: 'UTC+4' });
    expect(fixed.status).toBe(422);
  });

  it('AC16 + AC18: outbound/connection/return each get their own 4 milestones', async () => {
    const now = Date.now();
    const { orderId, segIds } = await confirmedOrder([new Date(now + 10 * 86400_000), new Date(now + 10 * 86400_000 + 6 * 3600_000), new Date(now + 17 * 86400_000)]);
    const occ = await p().reminderOccurrence.findMany({ where: { orderId, kind: 'milestone' } });
    expect(occ).toHaveLength(12);
    for (const segId of segIds) {
      expect(occ.filter((o) => o.segmentId === segId).map((o) => o.milestone).sort()).toEqual(['T-168h', 'T-24h', 'T-3h', 'T-72h']);
    }
    const seg = await p().flightSegment.findUniqueOrThrow({ where: { id: segIds[0]! } });
    const t168 = occ.find((o) => o.segmentId === segIds[0] && o.milestone === 'T-168h')!;
    expect(t168.dueAt.getTime()).toBe(seg.departureAtUtc!.getTime() - 168 * 3600_000);
    expect(t168.body).toContain('время аэропорта, Asia/Tashkent');
  });

  it('AC19: order entered 2h before departure → exactly one urgent check', async () => {
    const { orderId } = await confirmedOrder([new Date(Date.now() + 2 * 3600_000)]);
    const occ = await p().reminderOccurrence.findMany({ where: { orderId } });
    expect(occ).toHaveLength(1);
    expect(occ[0]!.milestone).toBe('URGENT');
  });

  it('missing departure time opens a "Reys vaqti kiritilmagan" task', async () => {
    const lead = await newLead(app, core);
    const s = await ownerSession(lead.ownerId!);
    const order = await s.post('/api/v1/orders', { leadId: lead.id });
    await s.post(`/api/v1/orders/${order.body.id}/segments`, { direction: 'outbound', originIata: 'TAS', destinationIata: 'IST', marketingCarrier: 'TK', flightNumber: '371', departure: null, departureTimezone: 'Asia/Tashkent', arrival: null, arrivalTimezone: 'Europe/Istanbul' });
    await s.patch(`/api/v1/orders/${order.body.id}`, { version: 1, fulfillmentState: 'confirmed' });
    expect(await p().crmTask.count({ where: { entityId: lead.id, kind: 'missing_departure' } })).toBe(1);
  });
});

describe('scheduler, checks and revisions (AC18, AC20–AC25)', () => {
  it('AC18/AC20: due milestone → one notification + one task; checking T-168h does not complete T-72h', async () => {
    const dep = new Date(Date.now() + 10 * 86400_000);
    const { orderId, segIds, s } = await confirmedOrder([dep]);
    clock.set(new Date(dep.getTime() - 168 * 3600_000 + 60_000));
    expect(await tick()).toBeGreaterThanOrEqual(1);
    expect(await tick()).toBe(0);
    await drain(core);
    const t168 = await p().reminderOccurrence.findFirstOrThrow({ where: { orderId, milestone: 'T-168h' } });
    expect(t168.state).toBe('due');
    expect(await p().notification.count({ where: { occurrenceId: t168.id } })).toBe(1);
    const task = await p().crmTask.findFirstOrThrow({ where: { entityType: 'occurrence', entityId: t168.id } });
    expect(task).toMatchObject({ kind: 'flight_check', state: 'pending' });
    expect((await p().flightSegment.findUniqueOrThrow({ where: { id: segIds[0]! } })).checkState).toBe('due');

    clock.real();
    const save = await s.post(`/api/v1/segments/${segIds[0]}/checks`, { action: 'save', result: 'confirmed', customerNotificationNeeded: false, note: 'Aviakompaniya saytida tekshirildi' });
    expect(save.status).toBe(201);
    expect(save.body).toMatchObject({ milestone: 'T-168h', source: 'manual', scheduleRevision: 1 });
    expect((await p().reminderOccurrence.findUniqueOrThrow({ where: { id: t168.id } })).state).toBe('completed');
    expect((await p().reminderOccurrence.findFirstOrThrow({ where: { orderId, milestone: 'T-72h' } })).state).toBe('scheduled');
    await drain(core);
    expect((await p().crmTask.findUniqueOrThrow({ where: { id: task.id } })).state).toBe('completed');

    clock.set(new Date(dep.getTime() - 72 * 3600_000 + 60_000));
    await tick();
    const t72 = await p().reminderOccurrence.findFirstOrThrow({ where: { orderId, milestone: 'T-72h' } });
    expect(t72.state).toBe('due');
    clock.real();
  });

  it('AC21: schedule change bumps revision, stale queued job is dropped, future reminders replanned', async () => {
    const dep = new Date(Date.now() + 10 * 86400_000);
    const { orderId, segIds, s } = await confirmedOrder([dep]);
    clock.set(new Date(dep.getTime() - 168 * 3600_000 + 60_000));
    const claimed = await core.reminders.claimDue('stale-worker', 200);
    const mine = (await p().reminderOccurrence.findMany({ where: { id: { in: claimed }, orderId } })).map((o) => o.id);
    expect(mine).toHaveLength(1);
    clock.real();
    // Schedule changes while the job is queued.
    const seg = await p().flightSegment.findUniqueOrThrow({ where: { id: segIds[0]! } });
    const newDep = new Date(dep.getTime() + 2 * 3600_000);
    const upd = await s.patch(`/api/v1/segments/${seg.id}`, { version: seg.version, departure: { local: tashkentLocal(newDep), timezone: 'Asia/Tashkent' } });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ scheduleRevision: 2, operationalStatus: 'schedule_changed' });
    expect(await core.reminders.dispatch(mine[0]!)).toBe('skipped');
    const old = await p().reminderOccurrence.findUniqueOrThrow({ where: { id: mine[0]! } });
    expect(old.state).toBe('superseded');
    expect(await p().notification.count({ where: { occurrenceId: old.id } })).toBe(0);
    const fresh = await p().reminderOccurrence.findMany({ where: { orderId, scheduleRevision: 2 } });
    expect(fresh.map((o) => o.milestone).sort()).toEqual(['T-168h', 'T-24h', 'T-3h', 'T-72h']);
    expect(await p().segmentRevision.count({ where: { segmentId: seg.id } })).toBe(2);
  });

  it('AC21: dispatch re-validates revision even if the row was claimed before the change', async () => {
    const dep = new Date(Date.now() + 10 * 86400_000);
    const { orderId, segIds } = await confirmedOrder([dep]);
    clock.set(new Date(dep.getTime() - 168 * 3600_000 + 60_000));
    const claimed = await core.reminders.claimDue('w', 200);
    const target = (await p().reminderOccurrence.findMany({ where: { id: { in: claimed }, orderId } }))[0]!;
    await p().flightSegment.update({ where: { id: segIds[0]! }, data: { scheduleRevision: { increment: 1 } } });
    expect(await core.reminders.dispatch(target.id)).toBe('dropped');
    expect((await p().reminderOccurrence.findUniqueOrThrow({ where: { id: target.id } })).state).toBe('superseded');
    clock.real();
  });

  it('AC22: cancelled order stops future reminders and closes open tasks; completed history stays', async () => {
    const dep = new Date(Date.now() + 10 * 86400_000);
    const { orderId, segIds, s } = await confirmedOrder([dep]);
    clock.set(new Date(dep.getTime() - 168 * 3600_000 + 60_000));
    await tick();
    clock.real();
    await s.post(`/api/v1/segments/${segIds[0]}/checks`, { action: 'save', result: 'confirmed', customerNotificationNeeded: false });
    const order = await p().order.findUniqueOrThrow({ where: { id: orderId } });
    const r = await s.patch(`/api/v1/orders/${orderId}`, { version: order.version, fulfillmentState: 'cancelled' });
    expect(r.status).toBe(200);
    const occ = await p().reminderOccurrence.findMany({ where: { orderId } });
    expect(occ.find((o) => o.milestone === 'T-168h')!.state).toBe('completed');
    expect(occ.filter((o) => o.milestone !== 'T-168h').every((o) => o.state === 'cancelled')).toBe(true);
    // A cancelled order frees the lead for a new order (history kept).
    expect(await p().order.count({ where: { id: orderId } })).toBe(1);
  });

  it('AC22: cancelled flight stops reminders and opens a customer-contact task', async () => {
    const { orderId, segIds, s, lead } = await confirmedOrder([new Date(Date.now() + 10 * 86400_000)]);
    const seg = await p().flightSegment.findUniqueOrThrow({ where: { id: segIds[0]! } });
    await s.patch(`/api/v1/segments/${seg.id}`, { version: seg.version, operationalStatus: 'cancelled' });
    expect((await p().reminderOccurrence.findMany({ where: { orderId } })).every((o) => o.state === 'cancelled')).toBe(true);
    expect(await p().crmTask.count({ where: { entityId: lead.id, kind: 'contact_customer' } })).toBe(1);
    expect((await p().flightSegment.findUniqueOrThrow({ where: { id: seg.id } })).notificationState).toBe('required');
  });

  it('AC23: closing the task (or completing via API) never counts as a flight check', async () => {
    const dep = new Date(Date.now() + 10 * 86400_000);
    const { orderId, segIds, s } = await confirmedOrder([dep]);
    clock.set(new Date(dep.getTime() - 168 * 3600_000 + 60_000));
    await tick();
    clock.real();
    await drain(core);
    const occ = await p().reminderOccurrence.findFirstOrThrow({ where: { orderId, milestone: 'T-168h' } });
    const task = await p().crmTask.findFirstOrThrow({ where: { entityId: occ.id } });
    await p().crmTask.update({ where: { id: task.id }, data: { state: 'completed' } });
    const r = await s.post(`/api/v1/reminders/${occ.id}/complete`, { note: 'qildim' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('CHECK_RESULT_REQUIRED');
    expect((await p().reminderOccurrence.findUniqueOrThrow({ where: { id: occ.id } })).state).toBe('due');
    expect(await p().flightCheck.count({ where: { segmentId: segIds[0]! } })).toBe(0);
  });

  it('AC24: manual recurring reminder with max count, snooze keeps history', async () => {
    const { orderId, s } = await confirmedOrder([new Date(Date.now() + 30 * 86400_000)]);
    const start = DateTime.now().setZone('Asia/Tashkent').plus({ hours: 1 }).startOf('minute');
    const bad = await s.post('/api/v1/reminders', { orderId, title: 'Viza', localStart: start.toFormat("yyyy-MM-dd'T'HH:mm"), timezone: 'Asia/Tashkent', recurrence: { kind: 'daily' } });
    expect(bad.status).toBe(422);
    const r = await s.post('/api/v1/reminders', { orderId, title: 'Viza hujjatlari', localStart: start.toFormat("yyyy-MM-dd'T'HH:mm"), timezone: 'Asia/Tashkent', recurrence: { kind: 'daily', maxCount: 2 } });
    expect(r.status).toBe(201);
    clock.set(new Date(start.toMillis() + 60_000));
    await tick();
    const series = () => p().reminderOccurrence.findMany({ where: { seriesId: r.body.seriesId }, orderBy: { seriesIndex: 'asc' } });
    let rows = await series();
    expect(rows.map((x) => [x.seriesIndex, x.state])).toEqual([[0, 'due'], [1, 'scheduled']]);
    expect(rows[1]!.dueAt.getTime() - rows[0]!.dueAt.getTime()).toBe(86400_000);
    clock.real();
    const sn = await s.patch(`/api/v1/reminders/${rows[0]!.id}`, { action: 'snooze', minutes: 30 });
    expect(sn.body.state).toBe('snoozed');
    expect(await p().auditLog.count({ where: { entityId: rows[0]!.id, action: 'snoozed' } })).toBe(1);
    clock.set(new Date(rows[1]!.dueAt.getTime() + 60_000));
    await tick();
    rows = await series();
    expect(rows).toHaveLength(2); // maxCount=2 → no third occurrence
    clock.real();
    const other = await login(app, 'menejer.c@demo.local');
    const owner = await p().order.findUniqueOrThrow({ where: { id: orderId } });
    if (owner.ownerId !== (await p().user.findUniqueOrThrow({ where: { email: 'menejer.c@demo.local' } })).id) {
      expect((await other.patch(`/api/v1/reminders/${rows[0]!.id}`, { action: 'cancel', reason: 'x' })).status).toBe(404);
    }
  });

  it('AC25: worker crash after claim → lease expiry → re-claimed; side effects not duplicated', async () => {
    const dep = new Date(Date.now() + 10 * 86400_000);
    const { orderId } = await confirmedOrder([dep]);
    const due = new Date(dep.getTime() - 168 * 3600_000 + 60_000);
    clock.set(due);
    const claimed = await core.reminders.claimDue('crashing-worker', 200, 60_000);
    const occ = (await p().reminderOccurrence.findMany({ where: { id: { in: claimed }, orderId } }))[0]!;
    // Worker dies here (no dispatch). Another worker cannot claim before the lease expires.
    expect(await core.reminders.claimDue('w2', 200)).not.toContain(occ.id);
    clock.set(new Date(due.getTime() + 61_000));
    expect(await core.reminders.claimDue('w2', 200)).toContain(occ.id);
    expect(await core.reminders.dispatch(occ.id)).toBe('dispatched');
    // Simulate a duplicate delivery of the same work after a restart.
    await p().reminderOccurrence.update({ where: { id: occ.id }, data: { state: 'dispatching' } });
    await core.reminders.dispatch(occ.id);
    expect(await p().notification.count({ where: { occurrenceId: occ.id } })).toBe(1);
    expect(await p().crmTask.count({ where: { entityId: occ.id } })).toBe(1);
    expect(await p().notificationDelivery.count({ where: { occurrenceId: occ.id } })).toBe(1); // faqat ilova ichidagi yetkazish (tashqi CRM vazifasi yo‘q)
    clock.real();
  });

  it('escalation: T-3h after 15 minutes goes to the head regardless of working hours', async () => {
    const dep = new Date(Date.now() + 10 * 86400_000);
    const { orderId } = await confirmedOrder([dep]);
    const due = new Date(dep.getTime() - 3 * 3600_000 + 1000);
    clock.set(due);
    await tick();
    const t3 = await p().reminderOccurrence.findFirstOrThrow({ where: { orderId, milestone: 'T-3h' } });
    expect(t3.escalatedAt).toBeNull();
    clock.set(new Date(due.getTime() + 16 * 60_000));
    await tick();
    expect((await p().reminderOccurrence.findUniqueOrThrow({ where: { id: t3.id } })).escalatedAt).not.toBeNull();
    const headId = (await p().user.findUniqueOrThrow({ where: { email: 'admin2@demo.local' } })).id;
    expect(await p().notification.count({ where: { occurrenceId: t3.id, userId: headId, kind: 'reminder_escalated' } })).toBe(1);
    clock.set(new Date(dep.getTime() + 60_000));
    await tick();
    expect((await p().reminderOccurrence.findMany({ where: { orderId, state: { in: ['scheduled', 'due'] } } })).length).toBe(0);
    expect((await p().reminderOccurrence.findUniqueOrThrow({ where: { id: t3.id } })).state).toBe('missed');
    clock.real();
  });

  it('flights board is sorted by departure and masks PNR for non-owners', async () => {
    const { s } = await confirmedOrder([new Date(Date.now() + 3 * 86400_000), new Date(Date.now() + 86400_000 * 2)]);
    const r = await s.get('/api/v1/flights?filter=7d');
    expect(r.status).toBe(200);
    const times = r.body.items.map((i: { departureAtUtc: string }) => Date.parse(i.departureAtUtc));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(r.body.items[0].liveData).toBe(false);
    expect(r.body.items[0].dataSource).toBe('manual');
  });
});
