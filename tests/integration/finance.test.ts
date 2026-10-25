import type { INestApplication } from '@nestjs/common';
import { DateTime } from 'luxon';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { DEMO_STATUS_IDS, type DemoAmoRestClient } from '@crm/integrations';
import { amoCrmSignal, drain, login, makeApp, makeCore, newLead, userId, type Session } from './helpers';

/**
 * Turoperatorlar, tannarx/sotuv/foyda, hujjat kategoriyalari va huquqlar (TZ qo'shimchasi §A–§E).
 * Har bir test o'z turoperatori bilan ishlaydi: dashboard turoperator filtri orqali boshqa fayllardagi
 * buyurtmalardan ajratiladi.
 */
let core: Core;
let app: INestApplication;
let head: Session;
let mgrA: Session;
let mgrB: Session;
let admin: Session;
const p = () => core.deps.prisma;
const amo = () => core.deps.adapters.amoRest({ id: '', accountDomain: null, accountId: '' }) as DemoAmoRestClient;

beforeAll(async () => {
  core = makeCore();
  app = await makeApp(core);
  head = await login(app, 'rahbar@demo.local');
  mgrA = await login(app, 'menejer.a@demo.local');
  mgrB = await login(app, 'menejer.b@demo.local');
  admin = await login(app, 'admin@demo.local');
  // Tannarx/foyda huquqi standartda menejerda yo'q: bu fayldagi moliyaviy oqimlar uchun administrator yoqadi.
  for (const email of ['menejer.a@demo.local', 'menejer.b@demo.local']) {
    const r = await admin.patch(`/api/v1/users/${await userId(core, email)}/finance-access`, { enabled: true });
    expect(r.status).toBe(200);
  }
});
afterAll(async () => {
  await app.close();
  await core.close();
});

let seq = 0;
async function makeOperator(name = `Turoperator ${Date.now()}-${++seq}`, kind = 'tour_operator') {
  const r = await head.post('/api/v1/suppliers', { name, kind });
  expect(r.status).toBe(201);
  return r.body as { id: string; name: string; version: number };
}

/** Lid rahbar tomonidan kerakli menejerga biriktiriladi (haqiqiy oqim: amoCRM tasdiqlaguncha pending). */
async function leadOwnedBy(email: string, operatorId?: string) {
  const lead = await newLead(app, core);
  const uid = await userId(core, email);
  if (lead.ownerId !== uid) {
    const r = await head.patch(`/api/v1/leads/${lead.id}/assignee`, { userId: uid, reason: 'test' });
    expect(r.status).toBe(202);
    await drain(core);
  }
  const fresh = await p().lead.findUniqueOrThrow({ where: { id: lead.id } });
  expect(fresh.ownerId).toBe(uid);
  if (operatorId) {
    const s = await login(app, email);
    const r = await s.patch(`/api/v1/leads/${lead.id}`, { version: fresh.version, tourOperatorId: operatorId });
    expect(r.status).toBe(200);
  }
  return p().lead.findUniqueOrThrow({ where: { id: lead.id } });
}

async function win(leadId: string) {
  const lead = await p().lead.findUniqueOrThrow({ where: { id: leadId } });
  await amo().simulateNativeEdit(lead.amoLeadId!, { statusId: DEMO_STATUS_IDS.WON }, new Date(Date.now() + 1000));
  await amoCrmSignal(app, core, lead.amoLeadId!);
  await drain(core);
}

const today = () => DateTime.now().setZone('Asia/Tashkent').toFormat('yyyy-MM-dd');
const tomorrow = () => DateTime.now().setZone('Asia/Tashkent').plus({ days: 1 }).toFormat('yyyy-MM-dd');
async function dashboard(session: Session, qs = '') {
  const keys = await core.deps.redis.keys('dash:*');
  if (keys.length) await core.deps.redis.del(...keys);
  const r = await session.get(`/api/v1/dashboard?from=${today()}&to=${tomorrow()}${qs}`);
  expect(r.status).toBe(200);
  return r.body;
}

async function order(session: Session, leadId: string, selling: string | null, currency: string | null, net?: string | null) {
  const r = await session.post('/api/v1/orders', { leadId, ...(selling ? { agreedAmount: selling, currency } : {}) });
  expect(r.status).toBe(201);
  let body = r.body;
  if (net !== undefined && net !== null) {
    const u = await session.patch(`/api/v1/orders/${body.id}`, { version: body.version, netPrice: net, ...(selling ? {} : { currency }) });
    expect(u.status).toBe(200);
    body = u.body;
  }
  return body as { id: string; version: number };
}
const card = async (session: Session, orderId: string) => (await session.get(`/api/v1/orders/${orderId}`)).body;

describe('turoperatorlar ma’lumotnomasi va huquqlar', () => {
  it('rahbar yaratadi; menejer yarata olmaydi va aloqa ma’lumotini ko‘rmaydi; nom takrorlanmaydi', async () => {
    const name = `Aloqali operator ${Date.now()}`;
    const created = await head.post('/api/v1/suppliers', { name, kind: 'tour_operator', contactPerson: 'Aziz', phone: '+998901112233', email: 'aziz@example.com', note: 'izoh' });
    expect(created.status).toBe(201);
    expect((await mgrA.post('/api/v1/suppliers', { name: 'Yashirin operator', kind: 'tour_operator' })).status).toBe(403);
    expect((await head.post('/api/v1/suppliers', { name: name.toUpperCase(), kind: 'tour_operator' })).status).toBe(409);

    const forHead = (await head.get('/api/v1/suppliers?status=all')).body.items.find((s: { id: string }) => s.id === created.body.id);
    expect(forHead).toMatchObject({ contactPerson: 'Aziz', phone: '+998901112233', email: 'aziz@example.com' });
    const forMgr = (await mgrA.get('/api/v1/suppliers?status=all')).body.items.find((s: { id: string }) => s.id === created.body.id);
    expect(forMgr).toMatchObject({ id: created.body.id, name });
    expect(forMgr).not.toHaveProperty('phone');
    expect(forMgr).not.toHaveProperty('email');
    expect(forMgr).not.toHaveProperty('contactPerson');
    expect((await mgrA.patch(`/api/v1/suppliers/${created.body.id}`, { version: 1, name: 'Hack' })).status).toBe(403);
  });

  it('arxivlangan turoperator yangi tanlanmaydi, eski tanlov va narxlar saqlanadi; o‘zgarishlar eski narxga ta’sir qilmaydi', async () => {
    const op = await makeOperator();
    const lead = await leadOwnedBy('menejer.a@demo.local', op.id);
    const o = await order(mgrA, lead.id, '1200.00', 'USD', '1000.00');
    const before = await card(mgrA, o.id);

    const renamed = await head.patch(`/api/v1/suppliers/${op.id}`, { version: op.version, name: `${op.name} (yangi nom)`, status: 'archived' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.status).toBe('archived');
    // eski tanlov o'zgarmaydi, narxlar ham
    const after = await card(mgrA, o.id);
    expect(after.finance.byCurrency.USD).toMatchObject({ selling: '1200.00', net: '1000.00', profit: '200.00' });
    expect(after.order.agreedAmount).toBe(before.order.agreedAmount);
    expect(after.tourOperator).toMatchObject({ id: op.id, status: 'archived' });
    // arxivdagini yangi lidga tanlab bo'lmaydi
    const other = await leadOwnedBy('menejer.a@demo.local');
    const pick = await mgrA.patch(`/api/v1/leads/${other.id}`, { version: other.version, tourOperatorId: op.id });
    expect(pick.status).toBe(422);
    expect(pick.body.error.code).toBe('SUPPLIER_ARCHIVED');
    // tanlov bo'yicha faol bo'lmagan hamkor xizmat qatoriga ham qo'shilmaydi
    const svc = await mgrA.post(`/api/v1/orders/${o.id}/services`, { serviceType: 'visa', description: 'Viza', supplierId: op.id });
    expect(svc.status).toBe(422);
    // audit: arxivlash yozilgan
    const audit = await p().auditLog.findFirst({ where: { entityType: 'supplier', entityId: op.id, action: 'archived' } });
    expect(audit).not.toBeNull();
  });

  it('turoperator reklama manbasidan alohida: lidning firstSource o‘zgarmaydi', async () => {
    const op = await makeOperator();
    const lead = await leadOwnedBy('menejer.a@demo.local');
    const source = lead.firstSource;
    const r = await mgrA.patch(`/api/v1/leads/${lead.id}`, { version: lead.version, tourOperatorId: op.id });
    expect(r.status).toBe(200);
    const fresh = await p().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(fresh.firstSource).toBe(source);
    expect(fresh.tourOperatorId).toBe(op.id);
    // manba bo'yicha dashboard filtri turoperatorni emas, kanalni ifodalaydi
    expect(Object.keys((await dashboard(head, `&tourOperatorId=${op.id}`)).periodMetrics.bySource)).toEqual([source]);
  });

  it('turoperator faqat tour_operator turida bo‘ladi (mehmonxona yetkazib beruvchisi lidga turoperator bo‘lib tanlanmaydi)', async () => {
    const hotel = await makeOperator(`Mehmonxona ${Date.now()}`, 'hotel');
    const lead = await leadOwnedBy('menejer.a@demo.local');
    const r = await mgrA.patch(`/api/v1/leads/${lead.id}`, { version: lead.version, tourOperatorId: hotel.id });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('SUPPLIER_KIND_MISMATCH');
    // lekin xizmat qatoriga yetkazib beruvchi sifatida tanlanadi
    const o = await order(mgrA, lead.id, null, null);
    const s = await mgrA.post(`/api/v1/orders/${o.id}/services`, { serviceType: 'hotel', description: 'Hilton', supplierId: hotel.id, details: { hotelName: 'Hilton', checkIn: '2026-11-01', checkOut: '2026-11-05' } });
    expect(s.status).toBe(201);
    expect(s.body.supplierId).toBe(hotel.id);
  });
});

describe('foyda = sotuv − tannarx (karta va dashboard mos)', () => {
  it('1 200 sotuv va 1 000 tannarxdan 200 foyda; karta va dashboard bir xil', async () => {
    const op = await makeOperator();
    const lead = await leadOwnedBy('menejer.a@demo.local', op.id);
    const o = await order(mgrA, lead.id, '1200.00', 'USD', '1000.00');
    const c = await card(mgrA, o.id);
    expect(c.order.agreedAmount).toBe('1200.00');
    expect(c.order.netPrice).toBe('1000.00');
    expect(c.finance.byCurrency.USD).toMatchObject({ selling: '1200.00', net: '1000.00', profit: '200.00', profitState: 'known', netComplete: true });
    expect(c.finance.formula).toContain('sof foyda');
    // sotuv yopilmaguncha: tasdiqlangan emas, kutilayotgan foyda
    let d = await dashboard(head, `&tourOperatorId=${op.id}`);
    expect(d.finance.confirmed.USD).toBeUndefined();
    await win(lead.id);
    d = await dashboard(head, `&tourOperatorId=${op.id}`);
    expect(d.finance.confirmed.USD).toMatchObject({ sales: '1200.00', profitBasis: { sales: '1200.00', net: '1000.00', profit: '200.00', orders: 1 }, undetermined: { orders: 0 } });
    expect(d.periodMetrics.salesByCurrency.USD).toBe('1200.00');
    expect(d.finance.byOperator.find((r: { operatorId: string }) => r.operatorId === op.id).currencies.USD.profitBasis.profit).toBe('200.00');
  });

  it('manfiy foyda to‘g‘ri ko‘rsatiladi va jamidan ayriladi', async () => {
    const op = await makeOperator();
    const l1 = await leadOwnedBy('menejer.a@demo.local', op.id);
    const l2 = await leadOwnedBy('menejer.b@demo.local', op.id);
    const o1 = await order(mgrA, l1.id, '1200.00', 'USD', '1000.00');
    const o2 = await order(mgrB, l2.id, '900.00', 'USD', '1000.00');
    expect((await card(mgrB, o2.id)).finance.byCurrency.USD.profit).toBe('-100.00');
    expect((await card(mgrA, o1.id)).finance.byCurrency.USD.profit).toBe('200.00');
    await win(l1.id);
    await win(l2.id);
    const d = await dashboard(head, `&tourOperatorId=${op.id}`);
    expect(d.finance.confirmed.USD.profitBasis).toMatchObject({ sales: '2100.00', net: '2000.00', profit: '100.00', orders: 2 });
    // menejerlar kesimi: A +200, B −100
    const mA = d.finance.byManager.find((r: { name: string }) => r.name.startsWith('Menejer A'));
    const mB = d.finance.byManager.find((r: { name: string }) => r.name.startsWith('Menejer B'));
    expect(mA.currencies.USD.profitBasis.profit).toBe('200.00');
    expect(mB.currencies.USD.profitBasis.profit).toBe('-100.00');
  });

  it('tannarxi noma’lum eski buyurtma: foyda «aniqlanmagan», 0 deb hisoblanmaydi, dashboard soni ko‘rsatadi', async () => {
    const op = await makeOperator();
    const l1 = await leadOwnedBy('menejer.a@demo.local', op.id);
    const l2 = await leadOwnedBy('menejer.a@demo.local', op.id);
    const known = await order(mgrA, l1.id, '1200.00', 'USD', '1000.00');
    const legacy = await order(mgrA, l2.id, '500.00', 'USD'); // tannarx kiritilmagan (eski buyurtma kabi)
    const c = await card(mgrA, legacy.id);
    expect(c.order.netPrice).toBeNull();
    expect(c.finance.byCurrency.USD).toMatchObject({ selling: '500.00', net: null, profit: null, profitState: 'undetermined' });
    expect(c.finance.profitUndetermined).toBe(true);
    expect((await card(mgrA, known.id)).finance.profitUndetermined).toBe(false);
    await win(l1.id);
    await win(l2.id);
    const d = await dashboard(head, `&tourOperatorId=${op.id}`);
    expect(d.finance.undeterminedOrders).toBe(1);
    expect(d.finance.confirmed.USD.sales).toBe('1700.00'); // jami sotuvga kiradi
    expect(d.finance.confirmed.USD.profitBasis).toMatchObject({ net: '1000.00', profit: '200.00', orders: 1 }); // tannarx/foydaga kirmaydi
    expect(d.finance.confirmed.USD.undetermined).toMatchObject({ orders: 1, sales: '500.00' });
    // baza darajasida tannarx NULL, 0 emas
    expect((await p().order.findUniqueOrThrow({ where: { id: legacy.id } })).netPriceMinor).toBeNull();
  });

  it('turli valyutalar kurssiz qo‘shilmaydi: har biri alohida hisoblanadi', async () => {
    const op = await makeOperator();
    const lead = await leadOwnedBy('menejer.a@demo.local', op.id);
    const o = await order(mgrA, lead.id, '1000.00', 'USD', '800.00');
    const svc = await mgrA.post(`/api/v1/orders/${o.id}/services`, { serviceType: 'transfer', description: 'Transfer', amount: '500000.00', netAmount: '300000.00', currency: 'UZS', details: { route: 'Aeroport → mehmonxona', pickupAt: '2026-11-01T10:00' } });
    expect(svc.status).toBe(201);
    const c = await card(mgrA, o.id);
    expect(Object.keys(c.finance.byCurrency).sort()).toEqual(['USD', 'UZS']);
    expect(c.finance.byCurrency.USD.profit).toBe('200.00');
    expect(c.finance.byCurrency.UZS.profit).toBe('200000.00');
    await win(lead.id);
    const d = await dashboard(head, `&tourOperatorId=${op.id}`);
    expect(d.finance.confirmed.USD.profitBasis.profit).toBe('200.00');
    expect(d.finance.confirmed.UZS.profitBasis.profit).toBe('200000.00');
    // valyuta filtri faqat bittasini qoldiradi
    const usdOnly = await dashboard(head, `&tourOperatorId=${op.id}&currency=USD`);
    expect(Object.keys(usdOnly.finance.confirmed)).toEqual(['USD']);
    expect(Object.keys(usdOnly.periodMetrics.salesByCurrency)).toEqual(['USD']);
    // valyutani kurssiz almashtirib bo'lmaydi
    const bad = await mgrA.patch(`/api/v1/orders/${o.id}`, { version: c.order.version, currency: 'EUR' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('CURRENCY_CHANGE_REQUIRES_AMOUNTS');
  });

  it('paket narxi va uning ichidagi xizmatlar ikki marta sanalmaydi; paketdan tashqari xizmat qo‘shiladi', async () => {
    const op = await makeOperator();
    const lead = await leadOwnedBy('menejer.a@demo.local', op.id);
    const o = await order(mgrA, lead.id, '1000.00', 'USD', '800.00');
    const inc = await mgrA.post(`/api/v1/orders/${o.id}/services`, { serviceType: 'hotel', description: 'Hilton (paketda)', amount: '600.00', netAmount: '500.00', currency: 'USD', includedInPackage: true, details: { hotelName: 'Hilton', checkIn: '2026-11-01', checkOut: '2026-11-08', mealPlan: 'BB', roomType: 'Double' } });
    expect(inc.status).toBe(201);
    let c = await card(mgrA, o.id);
    expect(c.finance.byCurrency.USD).toMatchObject({ selling: '1000.00', net: '800.00', profit: '200.00', lines: 1 });
    const extra = await mgrA.post(`/api/v1/orders/${o.id}/services`, { serviceType: 'visa', description: 'Viza', amount: '100.00', netAmount: '60.00', currency: 'USD' });
    expect(extra.status).toBe(201);
    c = await card(mgrA, o.id);
    expect(c.finance.byCurrency.USD).toMatchObject({ selling: '1100.00', net: '860.00', profit: '240.00' });
    // paketga kiritilgan xizmat chiqarib tashlanganda ham jami o'zgarmaydi; paketdan tashqari xizmat olib tashlansa kamayadi
    expect((await mgrA.delete(`/api/v1/services/${extra.body.id}`)).status).toBe(200);
    c = await card(mgrA, o.id);
    expect(c.finance.byCurrency.USD.profit).toBe('200.00');
    expect(c.order.services).toHaveLength(1); // soft-delete: ro'yxatda yo'q
    expect(await p().orderService.count({ where: { id: extra.body.id } })).toBe(1); // lekin bazada tarix qoladi
    await win(lead.id);
    const d = await dashboard(head, `&tourOperatorId=${op.id}`);
    expect(d.finance.confirmed.USD.profitBasis).toMatchObject({ sales: '1000.00', net: '800.00', profit: '200.00' });
  });

  it('paket narxisiz buyurtma: jami qiymat xizmatlar yig‘indisi; WON uchun «kelishilgan summa» xizmatlardan hisoblanadi', async () => {
    const op = await makeOperator();
    const lead = await leadOwnedBy('menejer.a@demo.local', op.id);
    const o = await order(mgrA, lead.id, null, null);
    await mgrA.post(`/api/v1/orders/${o.id}/services`, { serviceType: 'avia', description: 'Aviachipta', amount: '700.00', netAmount: '650.00', currency: 'USD' });
    await mgrA.post(`/api/v1/orders/${o.id}/services`, { serviceType: 'hotel', description: 'Hotel', amount: '300.00', netAmount: '200.00', currency: 'USD', details: { hotelName: 'Rixos', checkIn: '2026-11-01', checkOut: '2026-11-04' } });
    const c = await card(mgrA, o.id);
    expect(c.finance.byCurrency.USD).toMatchObject({ selling: '1000.00', net: '850.00', profit: '150.00' });
    const fresh = await p().lead.findUniqueOrThrow({ where: { id: lead.id } });
    const pre = await mgrA.patch(`/api/v1/leads/${lead.id}/stage`, { version: fresh.version, stage: 'WON' });
    expect(pre.status).toBe(422); // sotuv dalili yo'q
    expect(pre.body.error.field_errors).toHaveProperty('order.sale_evidence');
    expect(pre.body.error.field_errors).not.toHaveProperty('order.agreed_amount');
  });

  it('xizmat tafsilotlari tekshiriladi (mehmonxona sanalari, transfer yo‘nalishi) va narx o‘zgarishi auditga yoziladi', async () => {
    const lead = await leadOwnedBy('menejer.a@demo.local');
    const o = await order(mgrA, lead.id, '1000.00', 'USD', '800.00');
    const badHotel = await mgrA.post(`/api/v1/orders/${o.id}/services`, { serviceType: 'hotel', description: 'x', details: { hotelName: 'A', checkIn: '2026-11-10', checkOut: '2026-11-01' } });
    expect(badHotel.status).toBe(422);
    expect(badHotel.body.error.field_errors).toHaveProperty('details.checkOut');
    expect((await mgrA.post(`/api/v1/orders/${o.id}/services`, { serviceType: 'transfer', description: 'x', details: {} })).status).toBe(422);
    expect((await mgrA.post(`/api/v1/orders/${o.id}/services`, { serviceType: 'visa', description: 'x', amount: '10.00' })).status).toBe(422); // valyutasiz narx
    expect((await mgrA.post(`/api/v1/orders/${o.id}/services`, { serviceType: 'visa', description: 'x', amount: '-10.00', currency: 'USD' })).status).toBe(422);

    const ok = await mgrA.post(`/api/v1/orders/${o.id}/services`, { serviceType: 'visa', description: 'Viza', amount: '100.00', netAmount: '60.00', currency: 'USD' });
    const upd = await mgrA.patch(`/api/v1/services/${ok.body.id}`, { amount: '120.00' });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ amount: '120.00', netAmount: '60.00', profit: '60.00' });
    const rows = await p().auditLog.findMany({ where: { entityType: 'order', entityId: o.id, action: { in: ['price_updated', 'service_price_updated', 'service_added'] } }, orderBy: { createdAt: 'asc' } });
    const priceAudit = rows.find((r) => r.action === 'service_price_updated');
    expect(priceAudit).toBeDefined();
    expect(priceAudit!.oldValue).toMatchObject({ amount: '100.00', netAmount: '60.00' });
    expect(priceAudit!.newValue).toMatchObject({ amount: '120.00', netAmount: '60.00' });
    // buyurtma narxi o'zgarishi ham eski/yangi qiymat bilan
    const base = await card(mgrA, o.id);
    const upd2 = await mgrA.patch(`/api/v1/orders/${o.id}`, { version: base.order.version, netPrice: '900.00' });
    expect(upd2.status).toBe(200);
    const pa = await p().auditLog.findFirst({ where: { entityType: 'order', entityId: o.id, action: 'price_updated' }, orderBy: { createdAt: 'desc' } });
    expect(pa!.oldValue).toMatchObject({ netPriceMinor: '80000' });
    expect(pa!.newValue).toMatchObject({ netPrice: '900.00' });
  });

  it('bekor qilingan buyurtma jami sotuvga kirmaydi, summalar tarixda saqlanadi', async () => {
    const op = await makeOperator();
    const l1 = await leadOwnedBy('menejer.a@demo.local', op.id);
    const l2 = await leadOwnedBy('menejer.a@demo.local', op.id);
    const keep = await order(mgrA, l1.id, '1200.00', 'USD', '1000.00');
    const gone = await order(mgrA, l2.id, '800.00', 'USD', '700.00');
    await win(l1.id);
    await win(l2.id);
    let d = await dashboard(head, `&tourOperatorId=${op.id}`);
    expect(d.finance.confirmed.USD.sales).toBe('2000.00');
    const cur = await card(mgrA, gone.id);
    expect((await mgrA.patch(`/api/v1/orders/${gone.id}`, { version: cur.order.version, fulfillmentState: 'cancelled' })).status).toBe(200);
    d = await dashboard(head, `&tourOperatorId=${op.id}`);
    expect(d.finance.confirmed.USD.sales).toBe('1200.00');
    expect(d.finance.confirmed.USD.profitBasis.profit).toBe('200.00');
    expect(d.finance.cancelled.USD).toEqual({ sales: '800.00', orders: 1 });
    expect(d.periodMetrics.cancelledOrders).toBeGreaterThanOrEqual(1);
    // tarixiy summa o'chirilmagan; bekor qilingan buyurtma tahrirlanmaydi
    const after = await card(mgrA, gone.id);
    expect(after.order.agreedAmount).toBe('800.00');
    expect(after.order.netPrice).toBe('700.00');
    expect((await mgrA.post(`/api/v1/orders/${gone.id}/services`, { serviceType: 'visa', description: 'x' })).status).toBe(422);
    void keep;
  });

  it('qaytarim: dastlabki foyda o‘zgarmaydi, qaytarimdan keyingi foyda alohida; mijoz va yetkazib beruvchi qaytarimlari alohida qayd etiladi', async () => {
    const op = await makeOperator();
    const l1 = await leadOwnedBy('menejer.a@demo.local', op.id);
    const l2 = await leadOwnedBy('menejer.a@demo.local', op.id);
    const partial = await order(mgrA, l1.id, '1200.00', 'USD', '1000.00');
    const full = await order(mgrA, l2.id, '600.00', 'USD', '500.00');
    const pay = async (id: string, kind: string, amount: string, key: string) => {
      const r = await mgrA.post(`/api/v1/orders/${id}/payments`, { kind, amount, currency: 'USD', receivedAt: new Date().toISOString(), method: 'cash' }, { 'Idempotency-Key': key });
      expect(r.status).toBe(201);
      return r.body;
    };
    await pay(partial.id, 'payment', '1200.00', `p1-${partial.id}`);
    await pay(partial.id, 'refund', '200.00', `r1-${partial.id}`);
    await pay(full.id, 'payment', '600.00', `p2-${full.id}`);
    const r2 = await pay(full.id, 'refund', '600.00', `r2-${full.id}`);
    expect(r2.order.paymentState).toBe('refunded');
    await win(l1.id);
    await win(l2.id);
    const d = await dashboard(head, `&tourOperatorId=${op.id}`);
    // Dastlabki foyda qaytarimga bog'liq emas: (1200−1000) + (600−500) = 300; sotuv jami qaytarimlarni ham o'z ichiga oladi.
    expect(d.finance.confirmed.USD.sales).toBe('1800.00');
    expect(d.finance.confirmed.USD.profitBasis.profit).toBe('300.00');
    expect(d.finance.confirmed.USD.customerRefunded).toBe('800.00');
    expect(d.finance.confirmed.USD.ordersWithRefund).toBe(2);
    // Yetkazib beruvchi hali hech narsa qaytarmagan: qaytarimdan keyingi foyda = (1800−800) − 1500 = −500
    expect(d.finance.confirmed.USD.supplierRefunded).toBe('0.00');
    expect(d.finance.confirmed.USD.afterRefund.profit).toBe('-500.00');
    // Yetkazib beruvchi to'liq buyurtma tannarxini qaytardi (alohida qayd, idempotent)
    const receivedAt = new Date().toISOString();
    const sr = async (key: string, amount: string, currency = 'USD') =>
      mgrA.post(`/api/v1/orders/${full.id}/supplier-refunds`, { amount, currency, receivedAt }, { 'Idempotency-Key': key });
    expect((await sr(`s1-${full.id}`, '500.00')).status).toBe(201);
    expect((await sr(`s1-${full.id}`, '500.00')).status).toBe(201); // qayta yuborish o'sha javobni qaytaradi, ikkilanmaydi
    expect((await sr(`s2-${full.id}`, '1.00', 'EUR')).status).toBe(422); // valyuta mos emas
    expect((await sr(`s3-${full.id}`, '1.00')).status).toBe(422); // tannarxdan oshib ketadi
    const d2 = await dashboard(head, `&tourOperatorId=${op.id}`);
    expect(d2.finance.confirmed.USD.profitBasis.profit).toBe('300.00'); // dastlabki foyda o'zgarmaydi
    expect(d2.finance.confirmed.USD.supplierRefunded).toBe('500.00');
    expect(d2.finance.confirmed.USD.afterRefund).toMatchObject({ sales: '1000.00', net: '1000.00', profit: '0.00' });
    const cardFull = await card(head, full.id);
    expect(cardFull.finance.byCurrency.USD).toMatchObject({ profit: '100.00', customerRefunded: '600.00', supplierRefunded: '500.00', profitAfterRefund: '0.00' });
    expect(cardFull.supplierRefunds).toHaveLength(1);
    expect(await p().auditLog.count({ where: { entityId: full.id, action: 'supplier_refund_recorded' } })).toBe(1);
    // Mijozga qaytarim valyutasi buyurtma valyutasiga mos bo'lishi shart
    const bad = await mgrA.post(`/api/v1/orders/${partial.id}/payments`, { kind: 'refund', amount: '1.00', currency: 'EUR', receivedAt: new Date().toISOString(), method: 'cash' }, { 'Idempotency-Key': `bad-${partial.id}` });
    expect(bad.status).toBe(422);
  });

  it('to‘lov holati paket + paketdan tashqari xizmatlar jamiga nisbatan hisoblanadi', async () => {
    const lead = await leadOwnedBy('menejer.a@demo.local');
    const o = await order(mgrA, lead.id, '1000.00', 'USD', '800.00');
    await mgrA.post(`/api/v1/orders/${o.id}/services`, { serviceType: 'visa', description: 'Viza', amount: '100.00', netAmount: '60.00', currency: 'USD' });
    const r1 = await mgrA.post(`/api/v1/orders/${o.id}/payments`, { kind: 'payment', amount: '1000.00', currency: 'USD', receivedAt: new Date().toISOString(), method: 'cash' }, { 'Idempotency-Key': `pp1-${o.id}` });
    expect(r1.body.order.paymentState).toBe('partial'); // jami 1 100, to'langan 1 000
    const r2 = await mgrA.post(`/api/v1/orders/${o.id}/payments`, { kind: 'payment', amount: '100.00', currency: 'USD', receivedAt: new Date().toISOString(), method: 'cash' }, { 'Idempotency-Key': `pp2-${o.id}` });
    expect(r2.body.order.paymentState).toBe('paid');
  });
});

describe('amoCRM ga tannarx va foyda chiqmaydi', () => {
  it('order.summary faqat sotuv jamini yuboradi (paket + paketdan tashqari xizmat); tannarx va foyda yo‘q', async () => {
    // amoCRM maydon xaritasi (haqiqiyda amo-config CLI yaratadi): sotuv summasi va buyurtma raqami.
    const fields: Array<[string, string]> = [['local_amount', 'cf_local_amount'], ['travel_order_id', 'cf_order_id']];
    for (const [localId, externalId] of fields) {
      await p().integrationMapping.upsert({
        where: { companyId_entityType_externalId: { companyId: (await p().company.findFirstOrThrow()).id, entityType: 'custom_field', externalId } },
        update: {},
        create: { companyId: (await p().company.findFirstOrThrow()).id, entityType: 'custom_field', localId, externalId },
      });
    }
    const lead = await leadOwnedBy('menejer.a@demo.local');
    const o = await order(mgrA, lead.id, '1000.00', 'USD', '800.00');
    await mgrA.post(`/api/v1/orders/${o.id}/services`, { serviceType: 'visa', description: 'Viza', amount: '100.00', netAmount: '60.00', currency: 'USD' });
    await win(lead.id);
    await drain(core, 60);
    await core.deps.prisma.outboxOperation.updateMany({ where: { state: { in: ['failed', 'pending'] } }, data: { nextAttemptAt: new Date(0) } });
    await drain(core);
    const fresh = await p().lead.findUniqueOrThrow({ where: { id: lead.id } });
    const remote = await amo().getLead(fresh.amoLeadId!);
    const values = Object.values(remote?.customFields ?? {}).map(String);
    expect(values.some((v) => v.includes('1100.00 USD'))).toBe(true); // jami sotuv
    for (const secret of ['800.00', '860.00', '240.00', '860', '240']) expect(values.some((v) => v.includes(secret))).toBe(false);
  });
});

describe('ruxsatlar: moliya, eksport va dashboard', () => {
  it('menejer faqat o‘z buyurtmasi moliyasini ko‘radi; boshqasiniki 404; dashboard o‘z doirasida', async () => {
    const op = await makeOperator();
    const lA = await leadOwnedBy('menejer.a@demo.local', op.id);
    const lB = await leadOwnedBy('menejer.b@demo.local', op.id);
    const oA = await order(mgrA, lA.id, '1200.00', 'USD', '1000.00');
    const oB = await order(mgrB, lB.id, '300.00', 'USD', '100.00');
    await win(lA.id);
    await win(lB.id);
    expect((await mgrB.get(`/api/v1/orders/${oA.id}`)).status).toBe(404);
    const versionA = (await card(mgrA, oA.id)).order.version;
    expect((await mgrB.patch(`/api/v1/orders/${oA.id}`, { version: versionA, netPrice: '1.00' })).status).toBe(404);
    expect((await mgrA.patch(`/api/v1/orders/${oA.id}`, { version: versionA, netPrice: '1000.00' })).status).toBe(200);
    expect((await mgrB.post(`/api/v1/orders/${oA.id}/services`, { serviceType: 'visa', description: 'x' })).status).toBe(404);
    // dashboard: menejer B faqat o'z sotuvini ko'radi, kompaniya bo'yicha emas
    const dB = await dashboard(mgrB, `&tourOperatorId=${op.id}`);
    expect(dB.finance.confirmed.USD.sales).toBe('300.00');
    expect(dB.finance.byManager.every((r: { name: string }) => r.name.startsWith('Menejer B'))).toBe(true);
    const dHead = await dashboard(head, `&tourOperatorId=${op.id}`);
    expect(dHead.finance.confirmed.USD.sales).toBe('1500.00');
    void oB;
  });

  it('buyurtmalar eksporti: menejerga yopiq, rahbarga ochiq; tannarxi noma’lum buyurtmada foyda bo‘sh va auditga yoziladi', async () => {
    const op = await makeOperator();
    const l1 = await leadOwnedBy('menejer.a@demo.local', op.id);
    const l2 = await leadOwnedBy('menejer.a@demo.local', op.id);
    const known = await order(mgrA, l1.id, '1200.00', 'USD', '1000.00');
    const legacy = await order(mgrA, l2.id, '500.00', 'USD');
    const q = `/api/v1/exports/orders.csv?from=${today()}&to=${tomorrow()}&tourOperatorId=${op.id}`;
    expect((await mgrA.get(q)).status).toBe(403);
    const r = await head.get(q);
    expect(r.status).toBe(200);
    const csv = r.text as string;
    const [header, ...rows] = csv.replace(String.fromCharCode(0xfeff), '').split('\n');
    expect(header).toContain('selling_price,net_price,profit_initial,profit_state,customer_refunded,supplier_refunded,profit_after_refund');
    const kr = rows.find((x) => x.includes((known as unknown as { orderNo?: string }).orderNo ?? '__')) ?? rows[0]!;
    expect(rows).toHaveLength(2);
    expect(rows.some((x) => x.includes(',1200.00,1000.00,200.00,known,'))).toBe(true);
    expect(rows.some((x) => x.includes(',500.00,,,undetermined,'))).toBe(true);
    void kr;
    void legacy;
    expect(await p().auditLog.count({ where: { entityType: 'export', action: 'orders_csv' } })).toBeGreaterThan(0);
  });
});

describe('hujjatlar: kategoriyalar, bog‘lash va huquqlar', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const upload = (s: Session, qs: string, body: Buffer, mime = 'image/png', name = 'fayl.png') =>
    request(app.getHttpServer())
      .post(`/api/v1/attachments?${qs}`)
      .set('Cookie', s.cookie)
      .set('X-CSRF-Token', decodeURIComponent((s.cookie.match(/crm_csrf=([^;]+)/) ?? [])[1] ?? ''))
      .set('Content-Type', mime)
      .set('X-File-Name', encodeURIComponent(name))
      .send(body);

  it('kategoriya bilan yuklanadi; mijoz, yo‘lovchi va buyurtmaga bog‘lanadi; buyurtma kartasida birga ro‘yxatlanadi', async () => {
    const lead = await leadOwnedBy('menejer.a@demo.local');
    const o = await order(mgrA, lead.id, '1000.00', 'USD', '800.00');
    const pax = await mgrA.post(`/api/v1/orders/${o.id}/passengers`, { fullName: 'Ali Valiyev', type: 'adult' });
    const detail = await card(mgrA, o.id);
    const contactId = detail.contact.id as string;

    const a = await upload(mgrA, `ownerType=passenger&ownerId=${pax.body.id}&category=passport`, png, 'image/png', 'pasport.png');
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ category: 'passport', ownerType: 'passenger' });
    const b = await upload(mgrA, `ownerType=order&ownerId=${o.id}&category=invoice`, png);
    expect(b.status).toBe(201);
    const c = await upload(mgrA, `ownerType=contact&ownerId=${contactId}&category=other`, png);
    expect(c.status).toBe(201);
    // noma'lum kategoriya rad etiladi
    expect((await upload(mgrA, `ownerType=order&ownerId=${o.id}&category=secret`, png)).status).toBe(422);
    // pasport ofis fayli bo'lmaydi
    const docx = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64, 2)]);
    const bad = await upload(mgrA, `ownerType=passenger&ownerId=${pax.body.id}&category=passport`, docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x.docx');
    expect(bad.status).toBe(422);

    const list = await mgrA.get(`/api/v1/attachments?ownerType=order&ownerId=${o.id}&related=1`);
    expect(list.status).toBe(200);
    const kinds = list.body.items.map((x: { ownerType: string; category: string }) => `${x.ownerType}:${x.category}`).sort();
    expect(kinds).toEqual(['contact:other', 'order:invoice', 'passenger:passport']);
    expect(list.body.items.find((x: { ownerType: string }) => x.ownerType === 'passenger').ownerLabel).toContain('Ali Valiyev');
    // kategoriyani o'zgartirish
    const re = await mgrA.patch(`/api/v1/attachments/${b.body.id}`, { category: 'payment_receipt' });
    expect(re.status).toBe(200);
    expect(re.body.category).toBe('payment_receipt');
  });

  it('boshqa menejerning hujjatini ochishga urinish rad etiladi (ro‘yxat, havola, yuklash, kategoriya, o‘chirish); rahbar ko‘ra oladi', async () => {
    const lead = await leadOwnedBy('menejer.a@demo.local');
    const o = await order(mgrA, lead.id, '1000.00', 'USD', '800.00');
    const pax = await mgrA.post(`/api/v1/orders/${o.id}/passengers`, { fullName: 'Vali Aliyev', type: 'adult' });
    const detail = await card(mgrA, o.id);
    const att = await upload(mgrA, `ownerType=passenger&ownerId=${pax.body.id}&category=passport`, png, 'image/png', 'maxfiy-pasport.png');
    expect(att.status).toBe(201);
    // skan: worker o'rniga to'g'ridan-to'g'ri toza deb belgilaymiz (skaner testlari alohida)
    await core.attachments.scanPending();
    const row = await p().attachment.findUniqueOrThrow({ where: { id: att.body.id } });
    expect(row.scanState).toBe('clean');

    expect((await mgrB.get(`/api/v1/attachments?ownerType=passenger&ownerId=${pax.body.id}`)).status).toBe(404);
    expect((await mgrB.get(`/api/v1/attachments?ownerType=order&ownerId=${o.id}&related=1`)).status).toBe(404);
    expect((await mgrB.get(`/api/v1/attachments?ownerType=contact&ownerId=${detail.contact.id}`)).status).toBe(404);
    expect((await mgrB.post(`/api/v1/attachments/${att.body.id}/link`)).status).toBe(404);
    expect((await mgrB.patch(`/api/v1/attachments/${att.body.id}`, { category: 'other' })).status).toBe(404);
    expect((await mgrB.delete(`/api/v1/attachments/${att.body.id}`)).status).toBe(404);
    expect((await upload(mgrB, `ownerType=order&ownerId=${o.id}&category=voucher`, png)).status).toBe(404);
    // egasi va rahbar — ochadi; yuklab olish imzosi foydalanuvchiga bog'langan (boshqa menejerning havolasi ishlamaydi)
    const link = await mgrA.post(`/api/v1/attachments/${att.body.id}/link`);
    expect(link.status).toBe(200);
    expect((await mgrB.get(link.body.url)).status).toBe(404);
    const dl = await mgrA.get(link.body.url);
    expect(dl.status).toBe(200);
    expect(dl.headers['cache-control']).toContain('no-store');
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect((await head.post(`/api/v1/attachments/${att.body.id}/link`)).status).toBe(200);
    // maxfiy ma'lumot auditga fayl nomi bilan tushmaydi (pasport)
    expect((await mgrA.delete(`/api/v1/attachments/${att.body.id}`)).status).toBe(200);
    const audits = await p().auditLog.findMany({ where: { entityType: 'passenger', entityId: pax.body.id } });
    expect(JSON.stringify(audits.map((x) => [x.oldValue, x.newValue]))).not.toContain('maxfiy-pasport');
    expect(audits.map((x) => x.action)).toEqual(expect.arrayContaining(['attachment_uploaded', 'attachment_downloaded', 'attachment_deleted']));
  });
});

describe('turoperator — buyurtmaning tarixiy bog‘lanishi', () => {
  it('buyurtma yaratilganda operator nusxalanadi; lid operatori faol buyurtma bilan o‘zgarmaydi; statistika o‘zgarmaydi', async () => {
    const op1 = await makeOperator();
    const op2 = await makeOperator();
    const lead = await leadOwnedBy('menejer.a@demo.local', op1.id);
    const o = await order(mgrA, lead.id, '1200.00', 'USD', '1000.00');
    await win(lead.id);
    expect((await card(mgrA, o.id)).tourOperator?.id).toBe(op1.id);
    expect((await p().order.findUniqueOrThrow({ where: { id: o.id } })).tourOperatorId).toBe(op1.id);
    // faol buyurtma bor: lid operatorini o'zgartirib bo'lmaydi
    const l = await p().lead.findUniqueOrThrow({ where: { id: lead.id } });
    const blocked = await mgrA.patch(`/api/v1/leads/${lead.id}`, { version: l.version, tourOperatorId: op2.id });
    expect(blocked.status).toBe(422);
    // lid operatori baribir (masalan ichki tuzatish) o'zgarsa ham eski sotuv statistikasi o'zgarmaydi
    await p().lead.update({ where: { id: lead.id }, data: { tourOperatorId: op2.id } });
    expect((await card(mgrA, o.id)).tourOperator?.id).toBe(op1.id);
    const d1 = await dashboard(head, `&tourOperatorId=${op1.id}`);
    expect(d1.finance.confirmed.USD.sales).toBe('1200.00');
    expect(d1.finance.confirmed.USD.profitBasis.profit).toBe('200.00');
    const d2 = await dashboard(head, `&tourOperatorId=${op2.id}`);
    expect(d2.finance.confirmed.USD).toBeUndefined();
  });

  it('buyurtma operatorini o‘zgartirish: tasdiqlangan buyurtmada sabab majburiy, auditga eski/yangi qiymat yoziladi, arxiv operator tanlanmaydi', async () => {
    const op1 = await makeOperator();
    const op2 = await makeOperator();
    const arch = await makeOperator();
    const lead = await leadOwnedBy('menejer.a@demo.local', op1.id);
    const o = await order(mgrA, lead.id, '600.00', 'USD', '500.00');
    await win(lead.id);
    const v = () => card(mgrA, o.id).then((c) => c.order.version as number);
    const noReason = await mgrA.patch(`/api/v1/orders/${o.id}`, { version: await v(), tourOperatorId: op2.id });
    expect(noReason.status).toBe(422);
    expect((await head.patch(`/api/v1/suppliers/${arch.id}`, { version: arch.version, status: 'archived' })).status).toBe(200);
    expect((await mgrA.patch(`/api/v1/orders/${o.id}`, { version: await v(), tourOperatorId: arch.id, tourOperatorReason: 'noto‘g‘ri tanlangan edi' })).status).toBe(422);
    const ok = await mgrA.patch(`/api/v1/orders/${o.id}`, { version: await v(), tourOperatorId: op2.id, tourOperatorReason: 'mijoz boshqa operatorga o‘tdi' });
    expect(ok.status).toBe(200);
    const row = await p().auditLog.findFirstOrThrow({ where: { entityId: o.id, action: 'tour_operator_changed' } });
    expect(JSON.stringify(row.oldValue)).toContain(op1.id);
    expect(JSON.stringify(row.newValue)).toContain(op2.id);
    expect(JSON.stringify(row.newValue)).toContain('mijoz boshqa operatorga');
    // bu aniq, auditli o'zgarish: statistika yangi operatorga o'tadi, eski operatorda qolmaydi
    expect((await dashboard(head, `&tourOperatorId=${op2.id}`)).finance.confirmed.USD.sales).toBe('600.00');
    expect((await dashboard(head, `&tourOperatorId=${op1.id}`)).finance.confirmed.USD).toBeUndefined();
  });
});

describe('tannarx va foydani ko‘rish huquqi (finance.cost.view)', () => {
  it('standartda rahbar va administratorda bor; menejerda yo‘q; faqat administrator menejerga yoqadi', async () => {
    const mgrBId = await userId(core, 'menejer.b@demo.local');
    expect((await mgrB.patch(`/api/v1/users/${mgrBId}/finance-access`, { enabled: true })).status).toBe(403); // menejer o'ziga bera olmaydi
    expect((await head.patch(`/api/v1/users/${mgrBId}/finance-access`, { enabled: true })).status).toBe(403); // rahbar ham bera olmaydi
    expect((await admin.patch(`/api/v1/users/${await userId(core, 'rahbar@demo.local')}/finance-access`, { enabled: true })).status).toBe(422); // faqat menejer uchun
    expect((await admin.patch(`/api/v1/users/${mgrBId}/finance-access`, { enabled: false })).status).toBe(200);
    expect((await mgrB.get('/api/v1/me')).body.capabilities).not.toContain('finance.cost.view');
    expect((await head.get('/api/v1/me')).body.capabilities).toContain('finance.cost.view');
    expect((await admin.get('/api/v1/me')).body.capabilities).toContain('finance.cost.view');
    expect(await p().auditLog.count({ where: { entityId: mgrBId, action: 'finance_cost_access_revoked' } })).toBeGreaterThan(0);
  });

  it('huquqsiz menejer: buyurtma kartasi, ro‘yxat, o‘zgartirish, xizmat, qaytarim, dashboard va eksportda tannarx/foyda chiqmaydi', async () => {
    const op = await makeOperator();
    const lead = await leadOwnedBy('menejer.b@demo.local', op.id);
    const o = await order(head, lead.id, '1200.00', 'USD', '1000.00'); // rahbar tannarxni kiritdi
    await win(lead.id);
    const c = await card(mgrB, o.id);
    expect(c.canCost).toBe(false);
    expect(c.order.netPrice).toBeNull();
    expect(c.order.costHidden).toBe(true);
    expect(JSON.stringify(c)).not.toContain('1000.00');
    expect(JSON.stringify(c)).not.toMatch(/"(profit|profitState|marginPercent|netAfterRefund|profitAfterRefund|supplierRefunded|netAmount|net)":/);
    const list = await mgrB.get('/api/v1/orders');
    expect(JSON.stringify(list.body)).not.toMatch(/"netPrice":"/);
    // o'zgartirish va xizmatga tannarx kiritish — 403
    expect((await mgrB.patch(`/api/v1/orders/${o.id}`, { version: c.order.version, netPrice: '1.00' })).status).toBe(403);
    expect((await mgrB.post(`/api/v1/orders/${o.id}/services`, { serviceType: 'visa', description: 'Viza', amount: '10.00', netAmount: '5.00', currency: 'USD' })).status).toBe(403);
    expect((await mgrB.post(`/api/v1/orders/${o.id}/supplier-refunds`, { amount: '1.00', currency: 'USD', receivedAt: new Date().toISOString() }, { 'Idempotency-Key': `nb-${o.id}` })).status).toBe(403);
    // dashboard: sotuv ko'rinadi, tannarx/foyda yo'q
    const d = await dashboard(mgrB, `&tourOperatorId=${op.id}`);
    expect(d.finance.costHidden).toBe(true);
    expect(d.finance.confirmed.USD.sales).toBe('1200.00');
    expect(d.finance.confirmed.USD).not.toHaveProperty('profitBasis');
    expect(d.finance.confirmed.USD).not.toHaveProperty('afterRefund');
    expect(JSON.stringify(d.finance)).not.toContain('1000.00');
    // eksport menejerga yopiq
    expect((await mgrB.get(`/api/v1/exports/orders.csv?from=${today()}&to=${tomorrow()}`)).status).toBe(403);
    // rahbar hammasini ko'radi
    const hc = await card(head, o.id);
    expect(hc.canCost).toBe(true);
    expect(hc.order.netPrice).toBe('1000.00');
  });

  it('administrator yoqgach menejer tannarx va foydani ko‘radi; audit yoziladi; o‘chirilgach yana yopiladi', async () => {
    const mgrBId = await userId(core, 'menejer.b@demo.local');
    expect((await admin.patch(`/api/v1/users/${mgrBId}/finance-access`, { enabled: true })).status).toBe(200);
    expect((await mgrB.get('/api/v1/me')).body.capabilities).toContain('finance.cost.view');
    expect(await p().auditLog.count({ where: { entityId: mgrBId, action: 'finance_cost_access_granted' } })).toBeGreaterThan(0);
    const lead = await leadOwnedBy('menejer.b@demo.local');
    const o = await order(mgrB, lead.id, '800.00', 'USD', '600.00');
    expect((await card(mgrB, o.id)).order.netPrice).toBe('600.00');
    expect((await admin.patch(`/api/v1/users/${mgrBId}/finance-access`, { enabled: false })).status).toBe(200);
    expect((await card(mgrB, o.id)).canCost).toBe(false);
  });

  it('eksport: rahbarda tannarx va qaytarimdan keyingi foyda ustunlari bor', async () => {
    const r = await head.get(`/api/v1/exports/orders.csv?from=${today()}&to=${tomorrow()}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('profit_after_refund');
  });
});
