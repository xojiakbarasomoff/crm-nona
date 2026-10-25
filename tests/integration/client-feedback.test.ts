import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { alwaysOnDuty, login, makeApp, makeCore, type Session } from './helpers';

/** Mijoz fikri: qidiruv, dashboard sana oralig'i va lidlar jadvali, operatorlar importi, holat banneri ma'lumoti. */
let core: Core;
let app: INestApplication;
let admin: Session;
let head: Session;
let mgrA: Session;
let mgrB: Session;
const p = () => core.deps.prisma;
const u = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-8);

beforeAll(async () => {
  core = makeCore();
  await alwaysOnDuty(core);
  app = await makeApp(core);
  admin = await login(app, 'admin@demo.local');
  head = await login(app, 'admin2@demo.local');
  mgrA = await login(app, 'menejer.a@demo.local');
  mgrB = await login(app, 'menejer.b@demo.local');
});
afterAll(async () => {
  await app.close();
  await core.close();
});

const search = (s: Session, q: string, limit = 50) => s.get(`/api/v1/leads?limit=${limit}&search=${encodeURIComponent(q)}`);
const ids = (r: { body: { items: Array<{ id: string }> } }) => r.body.items.map((i) => i.id);

describe('qidiruv', () => {
  it('lid nomi, ism/familiya, telefon, Telegram va Instagram username bo‘yicha; @ bilan va usiz; katta-kichik harf farqsiz; sahifadan tashqarida ham topadi', async () => {
    const tag = u();
    const ph = `+99891${tag.slice(-7)}`;
    const a = (await head.post('/api/v1/leads', { firstName: `Aziza${tag}`, lastName: `Karimova${tag}`, phone: ph, telegram: `tg_${tag}_a`, name: `Dubay safari ${tag}` })).body;
    // Instagram mijozi (username faqat kontaktda)
    const company = await p().company.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const igContact = await p().contact.create({ data: { companyId: company.id, instagramUsername: `ig_${tag}_b`, syncState: 'local_only' } });
    const igLead = await p().$transaction((tx) => core.leads.createLead(tx, { companyId: company.id, contactId: igContact.id, name: 'Instagram foydalanuvchisi', channel: 'instagram_direct', placement: 'instagram', inquiryId: null, serviceType: null, at: new Date(), actor: { type: 'system', companyId: company.id, name: 'test' } as never }));
    // Qidiruvdan keyin yaratilgan ko'plab yangi lid: eski mos lid birinchi sahifadan tashqarida qoladi
    for (let i = 0; i < 4; i++) await head.post('/api/v1/leads', { firstName: `Boshqa${i}${tag}` });

    for (const q of [`Dubay safari ${tag}`, `aziza${tag}`, `KARIMOVA${tag}`, `Aziza${tag} Karimova${tag}`, `Karimova${tag} Aziza${tag}`, `tg_${tag}_a`, `@tg_${tag}_a`, `@TG_${tag}_A`]) expect(ids(await search(head, q))).toContain(a.id);
    // Telefon: turli yozilishlar
    for (const q of [ph, ph.replace('+998', ''), `${ph.slice(0, 7)} ${ph.slice(7, 10)} ${ph.slice(10)}`, ph.slice(-7)]) expect(ids(await search(head, q))).toContain(a.id);
    for (const q of [`ig_${tag}_b`, `@ig_${tag}_b`]) expect(ids(await search(head, q))).toContain(igLead.id);
    // limit=1: natijaning birinchi sahifasi to'ldirilsa ham (server tomonda) mos lid chiqadi
    const one = await search(head, `tg_${tag}_a`, 1);
    expect(one.body.items.map((i: { id: string }) => i.id)).toEqual([a.id]);
    // Hech narsaga mos kelmasa — bo'sh
    expect(ids(await search(head, `yoq_${tag}_xyz`))).toEqual([]);
  });

  it('ko‘rinish doirasi: menejer qidiruvda faqat o‘z lidlarini ko‘radi (boshqaning telefon/username bo‘yicha topilmaydi)', async () => {
    const tag = u();
    const own = (await mgrA.post('/api/v1/leads', { firstName: `Mening${tag}`, telegram: `own_${tag}_x`, phone: `+99893${tag.slice(-7)}` })).body;
    const other = (await mgrB.post('/api/v1/leads', { firstName: `Begona${tag}`, telegram: `oth_${tag}_y`, phone: `+99894${tag.slice(-7)}` })).body;
    expect(ids(await search(mgrA, `own_${tag}_x`))).toEqual([own.id]);
    expect(ids(await search(mgrA, `@oth_${tag}_y`))).toEqual([]);
    expect(ids(await search(mgrA, `+99894${tag.slice(-7)}`))).toEqual([]);
    expect(ids(await search(head, `oth_${tag}_y`))).toEqual([other.id]);
    expect(ids(await search(admin, `Mening${tag}`))).toEqual([own.id]);
  });
});

describe('dashboard: sana oralig‘i va lidlar jadvali', () => {
  const at = async (leadId: string, iso: string) => p().lead.update({ where: { id: leadId }, data: { createdAt: new Date(iso) } });

  it('Asia/Tashkent chegaralari: boshlanish va tugash kunlari to‘liq kiradi; kun chegarasidan bir soniya oldin/keyin to‘g‘ri tomonga ketadi', async () => {
    const mk = async (label: string) => (await head.post('/api/v1/leads', { firstName: label })).body.id as string;
    // 2031-03-10: faqat shu sinov uchun ajratilgan kunlar (boshqa testlar ma'lumotiga to'qnashmaydi)
    const before = await mk('Oldingi kun oxiri'); // 09.03 23:59:59 Toshkent = 18:59:59Z
    const start = await mk('Kun boshi'); // 10.03 00:00:00 Toshkent = 09.03 19:00:00Z
    const end = await mk('Kun oxiri'); // 10.03 23:59:59 Toshkent = 18:59:59Z
    const after = await mk('Keyingi kun boshi'); // 11.03 00:00:00 Toshkent = 10.03 19:00:00Z
    await at(before, '2031-03-09T18:59:59.000Z');
    await at(start, '2031-03-09T19:00:00.000Z');
    await at(end, '2031-03-10T18:59:59.000Z');
    await at(after, '2031-03-10T19:00:00.000Z');
    const r = await head.get('/api/v1/dashboard/leads?from=2031-03-10&to=2031-03-10');
    expect(r.status).toBe(200);
    expect(ids(r).sort()).toEqual([start, end].sort());
    expect(r.body.total).toBe(2);
    expect(r.body.range).toMatchObject({ from: '2031-03-10', to: '2031-03-10', timezone: 'Asia/Tashkent' });
    // Ko'p kunlik oraliq ikkala chekka kunini ham qamraydi
    const wide = await head.get('/api/v1/dashboard/leads?from=2031-03-09&to=2031-03-11');
    expect(ids(wide)).toEqual(expect.arrayContaining([before, start, end, after]));
    // Jadval elementlari: mijoz/@username, manba, mas'ul, bosqich, yaratilgan vaqt
    expect(r.body.items[0]).toMatchObject({ source: 'manual', stage: 'NEW' });
    expect(r.body.items[0]).toHaveProperty('createdAt');
    expect(r.body.items[0]).toHaveProperty('ownerId');
    // Natija yo'q davr
    const none = await head.get('/api/v1/dashboard/leads?from=2031-04-01&to=2031-04-02');
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ total: 0, items: [] });
  });

  it('boshlanish tugashdan keyin bo‘lsa — tushunarli 422 (jadval va KPI ikkalasida)', async () => {
    for (const path of ['/api/v1/dashboard/leads', '/api/v1/dashboard']) {
      const r = await head.get(`${path}?from=2031-03-11&to=2031-03-10`);
      expect(r.status).toBe(422);
      expect(JSON.stringify(r.body)).toContain('Дата начала не может быть позже даты окончания');
    }
  });

  it('filtrlar va rol: manba/turoperator filtri qo‘llanadi; menejer jadvalda faqat o‘z lidlarini ko‘radi; jadval soni KPI «yangi lidlar» bilan mos', async () => {
    const mk = async (s: Session, label: string) => (await s.post('/api/v1/leads', { firstName: label })).body.id as string;
    const a = await mk(mgrA, 'JadvalA');
    const b = await mk(mgrB, 'JadvalB');
    for (const id of [a, b]) await at(id, '2031-05-05T07:00:00.000Z');
    const q = 'from=2031-05-05&to=2031-05-05';
    expect(ids(await head.get(`/api/v1/dashboard/leads?${q}`)).sort()).toEqual([a, b].sort());
    expect(ids(await mgrA.get(`/api/v1/dashboard/leads?${q}`))).toEqual([a]);
    expect(ids(await mgrB.get(`/api/v1/dashboard/leads?${q}`))).toEqual([b]);
    expect(ids(await head.get(`/api/v1/dashboard/leads?${q}&source=instagram_direct`))).toEqual([]);
    expect(ids(await head.get(`/api/v1/dashboard/leads?${q}&source=manual`)).sort()).toEqual([a, b].sort());
    // Turoperator filtri
    const op = (await head.post('/api/v1/suppliers', { name: `Filtr operator ${u()}`, kind: 'tour_operator' })).body;
    await p().lead.update({ where: { id: a }, data: { tourOperatorId: op.id } });
    expect(ids(await head.get(`/api/v1/dashboard/leads?${q}&tourOperatorId=${op.id}`))).toEqual([a]);
    // KPI bilan moslik (yaratilgan sana bo'yicha «Yangi lidlar»)
    const kpi = await head.get(`/api/v1/dashboard?${q}`);
    expect(kpi.status).toBe(200);
    expect(kpi.body.periodMetrics.newLeads).toBe(2);
    const table = await head.get(`/api/v1/dashboard/leads?${q}`);
    expect(table.body.total).toBe(kpi.body.periodMetrics.newLeads);
  });
});

describe('turoperatorlar importi', () => {
  const NAMES = ['ASIALUXE TRAVEL', 'AQUA TRAVEL GROUP', 'EASYBOOKING', 'Easybooking avia', 'KOMPAS', 'Don Avia', 'EnjoyFly', 'Iway', 'Gross'];

  it('idempotent: takroriy import dublikat yaratmaydi; EASYBOOKING va Easybooking avia alohida; katta-kichik harf farqsiz; mavjud yozuv va tarixga tegilmaydi; ro‘yxatlarda chiqadi', async () => {
    const pre = (await head.post('/api/v1/suppliers', { name: 'kompas', kind: 'tour_operator', note: 'oldindan mavjud' })).body; // KOMPAS bilan bir xil (katta-kichik harf farqsiz)
    const other = (await head.post('/api/v1/suppliers', { name: `Boshqa operator ${u()}`, kind: 'tour_operator' })).body;
    expect((await mgrA.post('/api/v1/suppliers/import-tour-operators', { names: NAMES })).status).toBe(403);
    const r1 = await head.post('/api/v1/suppliers/import-tour-operators', { names: [...NAMES, 'asialuxe travel', ' Gross '] });
    expect(r1.status).toBe(200);
    expect(r1.body.createdCount).toBe(NAMES.length - 1); // KOMPAS mavjud edi
    expect(r1.body.skipped).toEqual(['KOMPAS']);
    const r2 = await head.post('/api/v1/suppliers/import-tour-operators', { names: NAMES });
    expect(r2.body).toMatchObject({ createdCount: 0, skippedCount: NAMES.length });
    const list = (await head.get('/api/v1/suppliers?status=all&kind=tour_operator')).body.items as Array<{ id: string; name: string; note?: string | null }>;
    const names = list.map((x) => x.name.toLowerCase());
    for (const n of NAMES) expect(names.filter((x) => x === n.toLowerCase())).toHaveLength(1);
    expect(names).toContain('easybooking');
    expect(names).toContain('easybooking avia');
    expect(list.find((x) => x.id === pre.id)!.name).toBe('kompas'); // mavjud yozuv o'zgarmadi
    expect(list.some((x) => x.id === other.id)).toBe(true);
    // Menejer ham tanlov ro'yxatini ko'radi (lid/buyurtma/dashboard tanlovlari shu ro'yxatdan)
    const forManager = (await mgrA.get('/api/v1/suppliers?status=active&kind=tour_operator')).body.items as Array<{ name: string }>;
    expect(forManager.map((x) => x.name.toLowerCase())).toContain('easybooking avia');
  });
});

describe('holat banneri ma’lumoti', () => {
  it('/me: jonli Instagram Direct kiruvchi sinovi o‘tgan/o‘tmaganini maxfiy ma’lumotsiz qaytaradi', async () => {
    const company = await p().company.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const me0 = (await head.get('/api/v1/me')).body;
    expect(me0.liveStatus.instagramDirectInboundVerified).toBe(false);
    await p().integrationConnection.create({ data: { companyId: company.id, provider: 'META_DIRECT', mode: 'live', accountId: `ACC_${u()}`, routeToken: `rt-${u()}`, health: 'degraded', healthReason: 'awaiting_live_verification', settings: { verifiedInboundAt: new Date().toISOString() } } });
    const me1 = (await mgrA.get('/api/v1/me')).body;
    expect(me1.liveStatus).toEqual({ instagramDirectInboundVerified: true });
    expect(JSON.stringify(me1)).not.toMatch(/token|secret|credential/i);
  });
});
