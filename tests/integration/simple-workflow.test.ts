import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { drain, login, makeApp, makeCore, newLead, sendDirect, type Session } from './helpers';

let core: Core;
let app: INestApplication;
let admin: Session;
const p = () => core.deps.prisma;

beforeAll(async () => {
  core = makeCore();
  app = await makeApp(core);
  admin = await login(app, 'admin@demo.local');
});
afterAll(async () => {
  await app.close();
  await core.close();
});

async function setStatus(s: Session, leadId: string, status: string) {
  const lead = await p().lead.findUniqueOrThrow({ where: { id: leadId } });
  return s.patch(`/api/v1/leads/${leadId}/status`, { version: lead.version, status });
}

async function operator() {
  const r = await admin.post('/api/v1/suppliers', { name: `Simple op ${randomUUID().slice(0, 8)}`, kind: 'tour_operator' });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

describe('статусы лида (Новый / В работе / Продано / Отменён / Нет ответа)', () => {
  it('статус хранится в прежнем этапе без потерь; «Нет ответа» — отдельный статус; повтор того же статуса ничего не меняет', async () => {
    const lead = await newLead(app, core);
    const card = (await admin.get(`/api/v1/leads/${lead.id}`)).body;
    expect(card.status).toBe('NEW');
    expect(card.lead.leadType).toBe('NEW');
    let r = await setStatus(admin, lead.id, 'NO_ANSWER');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.stage).toBe('NO_ANSWER');
    r = await setStatus(admin, lead.id, 'IN_PROGRESS');
    expect(r.body.stage).toBe('CONTACTED');
    const v = r.body.version;
    r = await setStatus(admin, lead.id, 'IN_PROGRESS');
    expect(r.body.version).toBe(v);
    const list = (await admin.get('/api/v1/leads?status=IN_PROGRESS&limit=100')).body.items as Array<{ id: string; status: string }>;
    expect(list.find((l) => l.id === lead.id)?.status).toBe('IN_PROGRESS');
    expect((await admin.get('/api/v1/leads?status=NO_ANSWER&limit=100')).body.items.some((l: { id: string }) => l.id === lead.id)).toBe(false);
    expect((await admin.patch(`/api/v1/leads/${lead.id}/status`, { version: 1, status: 'SOLD' })).status).toBe(409);
  });

  it('«Продано» → один заказ; уход со статуса отменяет его, возврат восстанавливает тот же (без дубликата)', async () => {
    const lead = await newLead(app, core);
    await setStatus(admin, lead.id, 'SOLD');
    await setStatus(admin, lead.id, 'SOLD');
    const orders1 = await p().order.findMany({ where: { leadId: lead.id } });
    expect(orders1).toHaveLength(1);
    await setStatus(admin, lead.id, 'CANCELLED');
    expect((await p().order.findUniqueOrThrow({ where: { id: orders1[0]!.id } })).fulfillmentState).toBe('cancelled');
    await setStatus(admin, lead.id, 'SOLD');
    const orders2 = await p().order.findMany({ where: { leadId: lead.id } });
    expect(orders2).toHaveLength(1);
    expect(orders2[0]!.fulfillmentState).not.toBe('cancelled');
    expect(await p().auditLog.count({ where: { entityId: orders1[0]!.id, action: { in: ['cancelled_by_status', 'reactivated'] } } })).toBe(2);
  });

  it('повторное обращение того же клиента получает тип «Повторный»', async () => {
    const sender = `77${Date.now()}`;
    await sendDirect(app, core, { sender, text: 'Salom' });
    await drain(core);
    const conv = await p().conversation.findFirstOrThrow({ where: { scopedPeerId: sender } });
    const first = await p().lead.findFirstOrThrow({ where: { contactId: conv.contactId } });
    expect(first.leadType).toBe('NEW');
    // новый лид для уже известного контакта
    const again = await core.leads.createLead(p() as never, { companyId: first.companyId, contactId: first.contactId, name: 'Again', channel: 'manual', placement: 'manual', inquiryId: null, serviceType: null, at: new Date(), actor: { type: 'system', companyId: first.companyId, source: 'test' } as never, deferAssignment: true });
    expect(again.leadType).toBe('REPEAT');
  });
});

describe('блок «Продажа» и напоминание о вылете', () => {
  it('продажа сохраняется в тот же заказ, прибыль = цена − себестоимость, пустая себестоимость ≠ 0, цены в журнале', async () => {
    const lead = await newLead(app, core);
    expect((await admin.put(`/api/v1/leads/${lead.id}/sale`, { serviceType: 'avia' })).body.error.code).toBe('LEAD_NOT_SOLD');
    await setStatus(admin, lead.id, 'SOLD');
    const op = await operator();
    const bad = await admin.put(`/api/v1/leads/${lead.id}/sale`, { serviceType: 'other' });
    expect(bad.status).toBe(422);
    let r = await admin.put(`/api/v1/leads/${lead.id}/sale`, { serviceType: 'avia', tourOperatorId: op, amount: '1200', currency: 'USD' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ serviceType: 'avia', amount: '1200.00', netAmount: null, profit: null, currency: 'USD' });
    r = await admin.put(`/api/v1/leads/${lead.id}/sale`, { serviceType: 'avia', tourOperatorId: op, amount: '1200', netAmount: '1000.50', currency: 'USD' });
    expect(r.body).toMatchObject({ amount: '1200.00', netAmount: '1000.50', profit: '199.50' });
    r = await admin.put(`/api/v1/leads/${lead.id}/sale`, { serviceType: 'other', soldWhat: 'Viza', amount: '1200', netAmount: '1000.50', currency: 'USD' });
    expect(r.body).toMatchObject({ serviceType: 'other', soldWhat: 'Viza' });
    expect(await p().order.count({ where: { leadId: lead.id } })).toBe(1);
    expect(await p().auditLog.count({ where: { entityId: r.body.orderId, action: 'price_updated' } })).toBe(3);
    // смена валюты без новых сумм запрещена (без пересчёта по курсу)
    expect((await admin.put(`/api/v1/leads/${lead.id}/sale`, { serviceType: 'avia', currency: 'UZS' })).body.error.code).toBe('CURRENCY_CHANGE_REQUIRES_AMOUNTS');
  });

  it('менеджер без права на себестоимость: себестоимость и прибыль скрыты, ввести её нельзя', async () => {
    const lead = await newLead(app, core);
    const owner = await p().user.findFirstOrThrow({ where: { email: 'menejer.a@demo.local' } });
    await p().user.update({ where: { id: owner.id }, data: { extraCapabilities: [] } });
    await p().lead.update({ where: { id: lead.id }, data: { ownerId: owner.id } });
    const mgr = await login(app, owner.email!);
    expect((await setStatus(mgr, lead.id, 'SOLD')).status).toBe(200);
    expect((await mgr.put(`/api/v1/leads/${lead.id}/sale`, { serviceType: 'avia', amount: '500', netAmount: '400', currency: 'USD' })).status).toBe(403);
    const r = await mgr.put(`/api/v1/leads/${lead.id}/sale`, { serviceType: 'avia', amount: '500', currency: 'USD' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ amount: '500.00', netAmount: null, profit: null, costHidden: true });
  });

  it('напоминание: по умолчанию за 3 дня, одно на плановое время, ответственному со ссылкой на лид; «Ближайшие вылеты»', async () => {
    const lead = await newLead(app, core);
    await setStatus(admin, lead.id, 'SOLD');
    const dep = new Date(Date.now() + 10 * 24 * 3600_000);
    const body = { serviceType: 'avia', departureAt: dep.toISOString(), departureNote: 'HY-601 TAS→IST', remindEnabled: true };
    let r = await admin.put(`/api/v1/leads/${lead.id}/sale`, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.reminder).toMatchObject({ state: 'scheduled', timezone: 'Asia/Tashkent' });
    expect(new Date(r.body.reminder.dueAt).getTime()).toBe(dep.getTime() - 3 * 24 * 3600_000);
    await admin.put(`/api/v1/leads/${lead.id}/sale`, body); // повторное сохранение
    const occs = await p().reminderOccurrence.findMany({ where: { orderId: r.body.orderId } });
    expect(occs).toHaveLength(1);
    expect(occs[0]!.assigneeId).toBe(lead.ownerId);
    // своё время напоминания: прежнее отменяется, новое одно
    const custom = new Date(Date.now() + 60_000);
    r = await admin.put(`/api/v1/leads/${lead.id}/sale`, { ...body, remindAt: custom.toISOString() });
    const active = await p().reminderOccurrence.findMany({ where: { orderId: r.body.orderId, state: 'scheduled' } });
    expect(active).toHaveLength(1);
    expect(active[0]!.dueAt.getTime()).toBe(custom.getTime());
    // срабатывание: уведомление со ссылкой на лид, без дубликатов
    await p().reminderOccurrence.update({ where: { id: active[0]!.id }, data: { state: 'dispatching', dueAt: new Date(Date.now() - 1000) } });
    expect(await core.reminders.dispatch(active[0]!.id)).toBe('dispatched');
    expect(await core.reminders.dispatch(active[0]!.id)).toBe('skipped');
    const notes = await p().notification.findMany({ where: { occurrenceId: active[0]!.id, kind: 'reminder_due' } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ userId: lead.ownerId, link: `/leads/${lead.id}` });
    // тот же план после срабатывания не создаёт нового напоминания
    await admin.put(`/api/v1/leads/${lead.id}/sale`, { ...body, remindAt: custom.toISOString() });
    expect(await p().reminderOccurrence.count({ where: { orderId: r.body.orderId, state: { in: ['scheduled', 'due'] } } })).toBe(1);

    const up = (await admin.get('/api/v1/dashboard/departures')).body.items as Array<{ leadId: string; departureNote: string; reminder: { state: string } }>;
    const row = up.find((x) => x.leadId === lead.id);
    expect(row).toMatchObject({ departureNote: 'HY-601 TAS→IST', reminder: { state: 'due' } });
    expect(up.length).toBeLessThanOrEqual(15);
    // отмена: вылет уходит из списка, напоминания отменяются
    await setStatus(admin, lead.id, 'CANCELLED');
    expect(((await admin.get('/api/v1/dashboard/departures')).body.items as Array<{ leadId: string }>).some((x) => x.leadId === lead.id)).toBe(false);
    expect(await p().reminderOccurrence.count({ where: { orderId: r.body.orderId, state: 'scheduled' } })).toBe(0);
  });
});

describe('переписка Instagram в карточке лида', () => {
  it('только сообщения этого клиента; ответ уходит через outbox, «принято» только после ответа API; повтор с тем же ключом не отправляет второй раз', async () => {
    const sender = `55${Date.now()}`;
    const other = `56${Date.now()}`;
    await sendDirect(app, core, { sender, text: 'Turkiyaga tur bormi?' });
    await sendDirect(app, core, { sender: other, text: 'Boshqa mijoz' });
    await drain(core);
    const conv = await p().conversation.findFirstOrThrow({ where: { scopedPeerId: sender } });
    const lead = await p().lead.findFirstOrThrow({ where: { contactId: conv.contactId } });
    const card = (await admin.get(`/api/v1/leads/${lead.id}`)).body;
    const texts = card.conversations.flatMap((c: { messages: Array<{ content: string }> }) => c.messages.map((m) => m.content));
    expect(texts).toContain('Turkiyaga tur bormi?');
    expect(texts).not.toContain('Boshqa mijoz');
    expect(card.conversations[0].reply.allowed).toBe(true);

    expect((await admin.post(`/api/v1/leads/${lead.id}/messages`, { text: 'Ha, bor' })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = `reply-${randomUUID()}`;
    const a = await admin.post(`/api/v1/leads/${lead.id}/messages`, { text: 'Ha, bor' }, { 'Idempotency-Key': key });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.state).toBe('queued');
    const b = await admin.post(`/api/v1/leads/${lead.id}/messages`, { text: 'Ha, bor' }, { 'Idempotency-Key': key });
    expect(b.body.id).toBe(a.body.id);
    await drain(core);
    const sent = await p().message.findUniqueOrThrow({ where: { id: a.body.id } });
    expect(sent.state).toBe('accepted');
    expect(sent.providerMessageId).toBeTruthy();
    expect(await p().outboxOperation.count({ where: { operationKey: `direct.send:${a.body.id}` } })).toBe(1);
    expect(await p().message.count({ where: { conversationId: conv.id, direction: 'outbound', content: 'Ha, bor' } })).toBe(1);
  });

  it('окно ответа закрыто → сообщение сохраняется как неотправленное с понятной причиной, в Instagram ничего не уходит', async () => {
    const sender = `57${Date.now()}`;
    await sendDirect(app, core, { sender, text: 'Eski xabar' });
    await drain(core);
    const conv = await p().conversation.findFirstOrThrow({ where: { scopedPeerId: sender } });
    await p().conversation.update({ where: { id: conv.id }, data: { lastInboundAt: new Date(Date.now() - 30 * 24 * 3600_000) } });
    const lead = await p().lead.findFirstOrThrow({ where: { contactId: conv.contactId } });
    const r = await admin.post(`/api/v1/leads/${lead.id}/messages`, { text: 'Kech javob' }, { 'Idempotency-Key': `reply-${randomUUID()}` });
    expect(r.status).toBe(201);
    expect(r.body.state).toBe('failed');
    expect(r.body.error).toMatch(/Окно ответа закрыто/);
    expect(await p().outboxOperation.count({ where: { operationKey: `direct.send:${r.body.id}` } })).toBe(0);
  });
});
