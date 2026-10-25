import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { alwaysOnDuty, drain, login, makeApp, makeCore, type Session } from './helpers';

/** Qo'lda lid yaratish va mijozni tahrirlash. Tashqi provayderlar demo adapter (amoCRM — soxta). */
let core: Core;
let app: INestApplication;
let admin: Session;
let head: Session;
let mgrA: Session;
let mgrB: Session;
const p = () => core.deps.prisma;
const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9);
const phone = () => `+99890${uniq().slice(-7)}`;

beforeAll(async () => {
  core = makeCore();
  await alwaysOnDuty(core);
  app = await makeApp(core);
  admin = await login(app, 'admin@demo.local');
  head = await login(app, 'rahbar@demo.local');
  mgrA = await login(app, 'menejer.a@demo.local');
  mgrB = await login(app, 'menejer.b@demo.local');
});
afterAll(async () => {
  await app.close();
  await core.close();
});

const userId = async (email: string) => (await p().user.findUniqueOrThrow({ where: { email } })).id;

describe('qo‘lda lid yaratish', () => {
  it('faqat ismdan 201: «Yangi lid», manba «manual» (Instagram emas), mavjud qoidalar bilan mas’ul, amoCRM navbatiga tushadi', async () => {
    const r = await head.post('/api/v1/leads', { firstName: 'Aziza', note: 'Instagramdan emas, telefonda so‘radi' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ stage: 'NEW', firstSource: 'manual', firstPlacement: 'manual', note: 'Instagramdan emas, telefonda so‘radi' });
    expect(r.body.firstSource).not.toBe('instagram_direct');
    expect(r.body.name).toBe('Aziza');
    expect(r.body.ownerId).toBeTruthy(); // round-robin / navbatchi qoidasi
    expect(['round_robin', 'duty_fallback', 'sticky_owner']).toContain(r.body.assignmentReason);
    const contact = await p().contact.findUniqueOrThrow({ where: { id: r.body.contactId } });
    expect(contact).toMatchObject({ firstName: 'Aziza', lastName: null, fullName: 'Aziza', primaryPhone: null, telegramUsername: null });
    expect(await p().contactIdentifier.count({ where: { contactId: contact.id } })).toBe(0); // telefon/Telegram majburiy emas
    await drain(core);
    const synced = await p().lead.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(synced.amoLeadId).toBeTruthy(); // mavjud sinxronizatsiya mexanizmi
    expect(await p().auditLog.count({ where: { entityId: r.body.id, action: 'manual_created' } })).toBe(1);
  });

  it('ism yoki familiyadan kamida bittasi kerak; faqat familiya yetarli; lid nomi berilsa u ishlatiladi', async () => {
    const none = await head.post('/api/v1/leads', { phone: phone() });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('NAME_REQUIRED');
    const onlyLast = await head.post('/api/v1/leads', { lastName: 'Karimov', name: 'Dubay 2 kishi' });
    expect(onlyLast.status).toBe(201);
    expect(onlyLast.body.name).toBe('Dubay 2 kishi');
    expect((await p().contact.findUniqueOrThrow({ where: { id: onlyLast.body.contactId } })).fullName).toBe('Karimov');
  });

  it('telefon E.164 ga keltiriladi (davlat kodisiz rad etiladi); Telegram @ bilan ham, usiz ham, t.me havolasi ham; noto‘g‘ri username rad etiladi', async () => {
    const a = await head.post('/api/v1/leads', { firstName: 'Tg1', phone: '+998 90 123 45 67', telegram: '@Nona_Test1' });
    expect(a.status).toBe(201);
    const c = await p().contact.findUniqueOrThrow({ where: { id: a.body.contactId } });
    expect(c).toMatchObject({ primaryPhone: '+998901234567', telegramUsername: 'Nona_Test1' });
    expect(await p().contactIdentifier.count({ where: { contactId: c.id, type: 'phone', value: '+998901234567', active: true } })).toBe(1);
    const b = await head.post('/api/v1/leads', { firstName: 'Tg2', telegram: 'nona_test2' });
    expect((await p().contact.findUniqueOrThrow({ where: { id: b.body.contactId } })).telegramUsername).toBe('nona_test2');
    const link = await head.post('/api/v1/leads', { firstName: 'Tg3', telegram: 'https://t.me/nona_test3' });
    expect((await p().contact.findUniqueOrThrow({ where: { id: link.body.contactId } })).telegramUsername).toBe('nona_test3');
    const bad = await head.post('/api/v1/leads', { firstName: 'Tg4', telegram: '@ab' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('TELEGRAM_INVALID');
    const noCode = await head.post('/api/v1/leads', { firstName: 'Tel', phone: '901234568' });
    expect(noCode.status).toBe(422);
    expect(noCode.body.error.code).toBe('PHONE_INVALID');
  });

  it('telefon boshqa kontaktda bo‘lsa 409 + nomzodlar (avtomatik birlashtirilmaydi); mavjud kontaktni tanlash yoki yangisini majburan yaratish', async () => {
    const ph = phone();
    const first = await head.post('/api/v1/leads', { firstName: 'Birinchi', phone: ph });
    expect(first.status).toBe(201);
    const contactsBefore = await p().contact.count();
    const dup = await head.post('/api/v1/leads', { firstName: 'Ikkinchi', phone: ph });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('PHONE_EXISTS');
    expect(dup.body.error.details.candidates.map((c: { id: string }) => c.id)).toEqual([first.body.contactId]);
    expect(await p().contact.count()).toBe(contactsBefore); // hech narsa yaratilmadi / birlashtirilmadi

    // Mavjud kontaktni tanlash: yangi lid shu kontaktga, kontakt o'zgarmaydi
    const snapshot = await p().contact.findUniqueOrThrow({ where: { id: first.body.contactId } });
    const onExisting = await head.post('/api/v1/leads', { name: 'Yangi safar', existingContactId: first.body.contactId });
    expect(onExisting.status).toBe(201);
    expect(onExisting.body.contactId).toBe(first.body.contactId);
    expect(await p().contact.count()).toBe(contactsBefore);
    const after = await p().contact.findUniqueOrThrow({ where: { id: first.body.contactId } });
    expect({ n: after.fullName, ph: after.primaryPhone }).toEqual({ n: snapshot.fullName, ph: snapshot.primaryPhone });

    // Majburan yangi kontakt: umumiy deb belgilanadi va dublikat tekshiruvi yoziladi
    const forced = await head.post('/api/v1/leads', { firstName: 'Ikkinchi', phone: ph, forceNewContact: true });
    expect(forced.status).toBe(201);
    expect(forced.body.contactId).not.toBe(first.body.contactId);
    const ident = await p().contactIdentifier.findFirstOrThrow({ where: { contactId: forced.body.contactId, type: 'phone' } });
    expect(ident.shared).toBe(true);
    expect(await p().duplicateCandidate.count({ where: { contactIds: { has: forced.body.contactId } } })).toBeGreaterThan(0);
  });

  it('mas’ul: menejer faqat o‘ziga; rahbar tanlagan xodimga (mas’ul tanlash sababi «manual_selection»)', async () => {
    const a = await userId('menejer.a@demo.local');
    const b = await userId('menejer.b@demo.local');
    const own = await mgrA.post('/api/v1/leads', { firstName: 'MenejerA' });
    expect(own.status).toBe(201);
    expect(own.body.ownerId).toBe(a);
    expect((await mgrA.post('/api/v1/leads', { firstName: 'Boshqaga', ownerId: b })).status).toBe(403);
    const picked = await head.post('/api/v1/leads', { firstName: 'Tanlangan', ownerId: b });
    expect(picked.status).toBe(201);
    expect(picked.body).toMatchObject({ ownerId: b, assignmentReason: 'manual_selection' });
    expect((await head.post('/api/v1/leads', { firstName: 'Noto‘g‘ri', ownerId: '00000000-0000-4000-8000-000000000000' })).status).toBe(422);
  });
});

describe('mijozni tahrirlash (lid kartasi)', () => {
  it('egasi menejer o‘z lidida tahrirlay oladi, begona lidda — yo‘q; rahbar/admin mavjud huquqlari bilan; audit yoziladi', async () => {
    const a = await mgrA.post('/api/v1/leads', { firstName: 'Eski', lastName: 'Ism', telegram: 'old_name1' });
    expect(a.status).toBe(201);
    const ok = await mgrA.patch(`/api/v1/leads/${a.body.id}/contact`, { firstName: 'Yangi', lastName: 'Familiya', phone: '+998 91 000 11 22', telegram: '@new_name1' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ firstName: 'Yangi', lastName: 'Familiya', fullName: 'Yangi Familiya', primaryPhone: '+998910001122', telegramUsername: 'new_name1' });
    const audit = await p().auditLog.findFirstOrThrow({ where: { entityId: a.body.contactId, action: 'manual_edit' }, orderBy: { createdAt: 'desc' } });
    expect(audit.oldValue).toMatchObject({ firstName: 'Eski', telegram: 'old_name1' });
    expect(audit.newValue).toMatchObject({ firstName: 'Yangi', telegram: 'new_name1', phone: '+998910001122' });
    expect((await mgrB.patch(`/api/v1/leads/${a.body.id}/contact`, { firstName: 'Hujum' })).status).toBe(404); // begona lid — ko'rinmaydi
    expect((await head.patch(`/api/v1/leads/${a.body.id}/contact`, { telegram: null })).status).toBe(200);
    expect((await admin.patch(`/api/v1/leads/${a.body.id}/contact`, { lastName: null })).status).toBe(200);
    const final = await p().contact.findUniqueOrThrow({ where: { id: a.body.contactId } });
    expect(final).toMatchObject({ firstName: 'Yangi', lastName: null, fullName: 'Yangi', telegramUsername: null });
    expect((await head.patch(`/api/v1/leads/${a.body.id}/contact`, { firstName: null })).status).toBe(422); // ism ham, familiya ham bo'sh bo'lmaydi
  });

  it('tahrirlashda telefon boshqa kontaktda bo‘lsa 409; «baribir saqlash» — birlashtirmasdan, umumiy deb belgilab', async () => {
    const ph = phone();
    const other = await head.post('/api/v1/leads', { firstName: 'Egasi', phone: ph });
    const mine = await head.post('/api/v1/leads', { firstName: 'Boshqa' });
    const r = await head.patch(`/api/v1/leads/${mine.body.id}/contact`, { phone: ph });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PHONE_EXISTS');
    expect((await p().contact.findUniqueOrThrow({ where: { id: mine.body.contactId } })).primaryPhone).toBeNull();
    const forced = await head.patch(`/api/v1/leads/${mine.body.id}/contact`, { phone: ph, allowDuplicatePhone: true });
    expect(forced.status).toBe(200);
    expect((await p().contactIdentifier.findFirstOrThrow({ where: { contactId: mine.body.contactId, type: 'phone', value: ph } })).shared).toBe(true);
    expect(await p().contact.findUniqueOrThrow({ where: { id: other.body.contactId } })).toMatchObject({ primaryPhone: ph }); // birlashtirilmadi
    expect(await p().contactIdentifier.count({ where: { contactId: other.body.contactId, type: 'phone', active: true } })).toBe(1);
  });

  it('Instagram mijozida: ism/telefon/Telegram tahrirlanadi, lekin sender ID, akkaunt ID va yozishma bog‘lanishi o‘zgarmaydi; profil yangilanishi qo‘lda kiritilgan ismni bosib ketmaydi', async () => {
    const company = await p().company.findFirstOrThrow();
    const contact = await p().contact.create({ data: { companyId: company.id, fullName: null, syncState: 'pending_create' } });
    await p().contactIdentifier.create({ data: { companyId: company.id, contactId: contact.id, type: 'instagram_scoped', value: `IGS${uniq()}`, scope: 'ACC_TEST_1', verified: true } });
    const lead = await p().$transaction((tx) =>
      core.leads.createLead(tx, { companyId: company.id, contactId: contact.id, name: 'Instagram foydalanuvchisi', channel: 'instagram_direct', placement: 'instagram', inquiryId: null, serviceType: null, at: new Date(), actor: { type: 'system', companyId: company.id, name: 'test' } as never }),
    );
    const before = await p().contactIdentifier.findMany({ where: { contactId: contact.id }, orderBy: { id: 'asc' } });
    const r = await head.patch(`/api/v1/leads/${lead.id}/contact`, { firstName: 'Dilshod', lastName: 'Aliyev', phone: phone(), telegram: 'dilshod_tg' });
    expect(r.status).toBe(200);
    const afterIds = await p().contactIdentifier.findMany({ where: { contactId: contact.id, type: 'instagram_scoped' }, orderBy: { id: 'asc' } });
    expect(afterIds.map((i) => ({ v: i.value, s: i.scope, a: i.active }))).toEqual(before.filter((i) => i.type === 'instagram_scoped').map((i) => ({ v: i.value, s: i.scope, a: i.active })));
    // Profil (username) keyin kelsa — qo'lda ism saqlanadi
    await core.instagramProfiles.applyProfile(contact.id, company.id, { username: 'dilshod_ig', name: 'Boshqa Ism' });
    const c = await p().contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(c).toMatchObject({ fullName: 'Dilshod Aliyev', firstName: 'Dilshod', lastName: 'Aliyev', telegramUsername: 'dilshod_tg', instagramUsername: 'dilshod_ig' });
  });
});
