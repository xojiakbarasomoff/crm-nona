import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { alwaysOnDuty, drain, login, makeApp, makeCore, newLead, sendDirect, userId, type Session } from './helpers';

let core: Core;
let app: INestApplication;
let admin: Session;
const p = () => core.deps.prisma;
const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
const ids = (r: request.Response) => (r.body.items as Array<{ id: string }>).map((x) => x.id);

beforeAll(async () => {
  core = makeCore();
  await alwaysOnDuty(core);
  app = await makeApp(core);
  admin = await login(app, 'admin@demo.local');
});
afterAll(async () => {
  await app.close();
  await core.close();
});

async function leadOfSender(sender: string) {
  const conv = await p().conversation.findFirstOrThrow({ where: { scopedPeerId: sender } });
  return p().lead.findUniqueOrThrow({ where: { id: conv.leadId! } });
}

/** Yangi menejer: administrator taklif qiladi, xodim faollashtiradi va login qiladi (prod'dagi kabi asosiy navbatga avtomatik). */
async function newStaff(role: 'MANAGER' | 'USER' = 'MANAGER') {
  const email = `${role.toLowerCase()}${Date.now()}@staff.test`;
  const inv = await admin.post('/api/v1/users', { email, fullName: 'Yangi Xodim', role });
  expect(inv.status).toBe(201);
  const token = new URL(inv.body.activationUrl).searchParams.get('token');
  const password = 'Uzun-va-xavfsiz-parol-1';
  expect((await request(app.getHttpServer()).post('/api/v1/auth/activate').send({ token, password })).status).toBe(200);
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  const csrf = res.body.csrfToken as string;
  const srv = app.getHttpServer();
  const s: Session = {
    cookie,
    get: (x) => request(srv).get(x).set('Cookie', cookie),
    post: (x, b, h = {}) => request(srv).post(x).set('Cookie', cookie).set('X-CSRF-Token', csrf).set(h).send(b as object),
    patch: (x, b) => request(srv).patch(x).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(b as object),
    put: (x, b) => request(srv).put(x).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(b as object),
    delete: (x) => request(srv).delete(x).set('Cookie', cookie).set('X-CSRF-Token', csrf),
  };
  return { id: inv.body.userId as string, session: s };
}

describe('yangi Direct lidining tayinlanishi', () => {
  it('faollashtirilgan menejer asosiy navbatga tushadi va yangi Direct lidini oladi (duty_fallback emas); ro‘yxat, dashboard va bildirishnomada ko‘rinadi', async () => {
    const pool = await p().managerPool.findFirstOrThrow({ where: { isDefault: true } });
    const before = await p().managerPoolMember.findMany({ where: { poolId: pool.id }, select: { id: true, available: true } });
    // Prod holati: navbatdagi boshqa a'zolar ishlamaydi (eski demo menejerlar).
    await p().managerPoolMember.updateMany({ where: { poolId: pool.id }, data: { available: false } });
    const mgr = await newStaff();
    try {
      const member = await p().managerPoolMember.findFirstOrThrow({ where: { poolId: pool.id, userId: mgr.id } });
      expect(member).toMatchObject({ available: true, schedule: null });

      const sender = `96asg${Date.now()}`;
      await sendDirect(app, core, { sender, text: 'Salom, tur kerak' });
      await drain(core);
      const lead = await leadOfSender(sender);
      expect(lead).toMatchObject({ ownerId: mgr.id, assignmentReason: 'round_robin', firstSource: 'instagram_direct' });

      expect(ids(await mgr.session.get('/api/v1/leads?limit=50'))).toContain(lead.id);
      expect(ids(await mgr.session.get(`/api/v1/dashboard/leads?from=${day()}&to=${day()}`))).toContain(lead.id);
      const notes = (await mgr.session.get('/api/v1/notifications')).body.items as Array<{ kind: string; link: string | null }>;
      expect(notes.some((n) => n.kind === 'lead_assigned' && n.link === `/leads/${lead.id}`)).toBe(true);
    } finally {
      for (const m of before) await p().managerPoolMember.update({ where: { id: m.id }, data: { available: m.available } });
      await admin.post(`/api/v1/users/${mgr.id}/block`, { successorId: null });
      // Umumiy test bazasi: boshqa fayllardagi teng taqsimlash hisobiga aralashmasin.
      await p().managerPoolMember.deleteMany({ where: { poolId: pool.id, userId: mgr.id } });
    }
  });

  it('navbatda hech kim ishlamasa — dyejurniy administrator (`duty_fallback`) va sababi saqlanadi', async () => {
    const pool = await p().managerPool.findFirstOrThrow({ where: { isDefault: true } });
    await p().managerPoolMember.updateMany({ where: { poolId: pool.id }, data: { available: false } });
    try {
      const sender = `96dty${Date.now()}`;
      await sendDirect(app, core, { sender });
      await drain(core);
      const company = await p().company.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
      expect(await leadOfSender(sender)).toMatchObject({ assignmentReason: 'duty_fallback', ownerId: company.dutyUserId });
    } finally {
      await p().managerPoolMember.updateMany({ where: { poolId: pool.id }, data: { available: true } });
    }
  });
});

describe('qayta biriktirish', () => {
  it('administrator lidni boshqa menejerga o‘tkazadi: ikkala akkauntda ro‘yxat va hisoblagich darhol yangilanadi', async () => {
    const [a, b] = await Promise.all([login(app, 'menejer.a@demo.local'), login(app, 'menejer.b@demo.local')]);
    const [aId, bId] = await Promise.all([userId(core, 'menejer.a@demo.local'), userId(core, 'menejer.b@demo.local')]);
    const lead = await newLead(app, core);
    await p().lead.update({ where: { id: lead.id }, data: { ownerId: aId } });
    const dash = (s: Session) => s.get(`/api/v1/dashboard?from=${day()}&to=${day()}`).then((r) => r.body.periodMetrics.newLeads as number);
    // Keshni to'ldiramiz (20 s): qayta biriktirishdan keyin eski qiymat qaytmasligi kerak.
    const [aBefore, bBefore] = [await dash(a), await dash(b)];
    expect(ids(await a.get('/api/v1/leads?limit=100'))).toContain(lead.id);

    const r = await admin.patch(`/api/v1/leads/${lead.id}/assignee`, { userId: bId, reason: 'Решение администратора' });
    expect(r.status).toBe(200);
    expect(r.body.ownerId).toBe(bId);

    expect(ids(await a.get('/api/v1/leads?limit=100'))).not.toContain(lead.id);
    expect(ids(await b.get('/api/v1/leads?limit=100'))).toContain(lead.id);
    expect(await dash(a)).toBe(aBefore - 1);
    expect(await dash(b)).toBe(bBefore + 1);
    expect((await a.get(`/api/v1/leads/${lead.id}`)).status).toBe(404);
    const notes = (await b.get('/api/v1/notifications')).body.items as Array<{ kind: string; link: string | null }>;
    expect(notes.some((n) => n.kind === 'lead_assigned' && n.link === `/leads/${lead.id}`)).toBe(true);
    // Menejer o'zi qayta biriktira olmaydi.
    expect((await b.patch(`/api/v1/leads/${lead.id}/assignee`, { userId: aId, reason: 'x' })).status).toBe(403);
  });
});

describe('lidni o‘chirish (soft delete) va tiklash', () => {
  it('menejer o‘z lidini o‘chiradi: ro‘yxat, qidiruv, dashboard va yaqin uchishlardan chiqadi; moliya, kontakt, yozishma va audit qoladi; admin tiklaydi', async () => {
    const m = await login(app, 'menejer.a@demo.local');
    const mId = await userId(core, 'menejer.a@demo.local');
    const sender = `96del${Date.now()}`;
    await sendDirect(app, core, { sender, text: 'Dubayga tur' });
    await drain(core);
    const lead = await leadOfSender(sender);
    await p().lead.update({ where: { id: lead.id }, data: { ownerId: mId } });
    // Sotuv + kelajakdagi uchish + to'lov.
    const sold = await m.patch(`/api/v1/leads/${lead.id}/status`, { version: (await p().lead.findUniqueOrThrow({ where: { id: lead.id } })).version, status: 'SOLD' });
    expect(sold.status).toBe(200);
    const order = await p().order.findFirstOrThrow({ where: { leadId: lead.id } });
    await p().order.update({ where: { id: order.id }, data: { departureAt: new Date(Date.now() + 5 * 86_400_000) } });
    await p().payment.create({ data: { companyId: order.companyId, orderId: order.id, kind: 'payment', amountMinor: 50_000n, currency: 'USD', receivedAt: new Date(), method: 'cash', businessKey: `test-del-${order.id}`, recordedById: mId } });
    const contactName = (await p().contact.findUniqueOrThrow({ where: { id: lead.contactId } })).fullName ?? lead.name;

    const detail = await m.get(`/api/v1/leads/${lead.id}`);
    expect(detail.body.financeKept).toEqual({ orders: 1, payments: 1 });
    const depBefore = (await m.get('/api/v1/dashboard/departures')).body.items.map((x: { leadId: string }) => x.leadId);
    expect(depBefore).toContain(lead.id);
    const dashBefore = (await m.get(`/api/v1/dashboard?from=${day()}&to=${day()}`)).body.periodMetrics.newLeads as number;

    const del = await m.delete(`/api/v1/leads/${lead.id}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ deleted: true, financeKept: { orders: 1, payments: 1 } });

    expect(ids(await m.get('/api/v1/leads?limit=200'))).not.toContain(lead.id);
    expect(ids(await admin.get('/api/v1/leads?limit=200'))).not.toContain(lead.id);
    expect(ids(await admin.get(`/api/v1/leads?limit=50&search=${encodeURIComponent(contactName)}`))).not.toContain(lead.id);
    expect((await m.get('/api/v1/dashboard/departures')).body.items.map((x: { leadId: string }) => x.leadId)).not.toContain(lead.id);
    expect(ids(await m.get(`/api/v1/dashboard/leads?from=${day()}&to=${day()}`))).not.toContain(lead.id);
    expect((await m.get(`/api/v1/dashboard?from=${day()}&to=${day()}`)).body.periodMetrics.newLeads).toBe(dashBefore - 1);
    expect((await m.get(`/api/v1/leads/${lead.id}`)).status).toBe(404);

    // Jismonan hech narsa o'chmagan.
    const row = await p().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(await p().contact.count({ where: { id: lead.contactId } })).toBe(1);
    expect(await p().order.count({ where: { id: order.id } })).toBe(1);
    expect(await p().payment.count({ where: { orderId: order.id } })).toBe(1);
    expect(await p().message.count({ where: { conversation: { scopedPeerId: sender } } })).toBeGreaterThan(0);
    expect(await p().auditLog.count({ where: { entityId: lead.id, action: 'deleted' } })).toBe(1);

    // Administrator: «Удалённые» ro'yxati, karta va tiklash. Menejer tiklay olmaydi va o'chirilganlarni ko'rmaydi.
    expect(ids(await admin.get('/api/v1/leads?limit=200&deleted=true'))).toContain(lead.id);
    expect((await m.get('/api/v1/leads?deleted=true')).status).toBe(403);
    expect((await m.post(`/api/v1/leads/${lead.id}/restore`)).status).toBe(403);
    const card = await admin.get(`/api/v1/leads/${lead.id}`);
    expect(card.status).toBe(200);
    expect(card.body.lead.deletedAt).not.toBeNull();
    const restored = await admin.post(`/api/v1/leads/${lead.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ deletedAt: null, ownerId: mId, stage: 'WON' });
    expect(ids(await m.get('/api/v1/leads?limit=200'))).toContain(lead.id);
    expect((await m.get('/api/v1/dashboard/departures')).body.items.map((x: { leadId: string }) => x.leadId)).toContain(lead.id);
    expect(await p().auditLog.count({ where: { entityId: lead.id, action: 'restored' } })).toBe(1);
    expect((await admin.post(`/api/v1/leads/${lead.id}/restore`)).status).toBe(404);
  });

  it('rol cheklovlari: menejer begona lidni ID orqali o‘chira olmaydi (404), Пользователь o‘chira olmaydi (403), administrator istalganini o‘chiradi', async () => {
    const a = await login(app, 'menejer.a@demo.local');
    const bId = await userId(core, 'menejer.b@demo.local');
    const foreign = await newLead(app, core);
    await p().lead.update({ where: { id: foreign.id }, data: { ownerId: bId } });
    expect((await a.delete(`/api/v1/leads/${foreign.id}`)).status).toBe(404);
    expect((await a.get(`/api/v1/leads/${foreign.id}`)).status).toBe(404);
    expect((await p().lead.findUniqueOrThrow({ where: { id: foreign.id } })).deletedAt).toBeNull();

    // Пользователь (USER): o'zining lidini ham o'chira olmaydi.
    const usr = await newStaff('USER');
    const own = await newLead(app, core);
    await p().lead.update({ where: { id: own.id }, data: { ownerId: usr.id } });
    expect((await usr.session.get(`/api/v1/leads/${own.id}`)).status).toBe(200);
    expect((await usr.session.delete(`/api/v1/leads/${own.id}`)).status).toBe(403);
    expect((await p().lead.findUniqueOrThrow({ where: { id: own.id } })).deletedAt).toBeNull();
    // USER navbatga qo'shilmaydi.
    expect(await p().managerPoolMember.count({ where: { userId: usr.id } })).toBe(0);
    await admin.post(`/api/v1/users/${usr.id}/block`, { successorId: null });

    expect((await admin.delete(`/api/v1/leads/${foreign.id}`)).status).toBe(200);
    expect((await admin.delete(`/api/v1/leads/${foreign.id}`)).status).toBe(404);
    expect((await admin.post(`/api/v1/leads/${foreign.id}/restore`)).status).toBe(200);
  });
});
