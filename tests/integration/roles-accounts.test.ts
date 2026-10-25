import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { drain, makeApp, makeCore, newLead, sendDirect, type Session } from './helpers';

let core: Core;
let app: INestApplication;
const p = () => core.deps.prisma;
const tag = Date.now().toString(36);

/** Три рабочие роли: вход по логину (без email), пароль хранится только как argon2-хеш. */
const ACCOUNTS = [
  { login: `adm_${tag}`, fullName: 'Nozima Test', role: 'ADMIN' as const, password: 'nonatravel123' },
  { login: `mgr_${tag}`, fullName: 'Менеджер', role: 'MANAGER' as const, password: '12345' },
  { login: `usr_${tag}`, fullName: 'Пользователь', role: 'USER' as const, password: '12345' },
];

async function loginByName(loginName: string, password: string): Promise<Session> {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: loginName, password });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  const csrf = res.body.csrfToken as string;
  const srv = app.getHttpServer();
  return {
    cookie,
    get: (path) => request(srv).get(path).set('Cookie', cookie),
    post: (path, b, h = {}) => request(srv).post(path).set('Cookie', cookie).set('X-CSRF-Token', csrf).set(h).send(b as object),
    patch: (path, b) => request(srv).patch(path).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(b as object),
    put: (path, b) => request(srv).put(path).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(b as object),
    delete: (path) => request(srv).delete(path).set('Cookie', cookie).set('X-CSRF-Token', csrf),
  };
}

let adm: Session;
let mgr: Session;
let usr: Session;
let mgrId: string;
let usrId: string;
let origDuty: string | null = null;

beforeAll(async () => {
  // Как на рабочем стенде (APP_MODE=demo + DEMO_SIMPLE_LOGIN): у новых аккаунтов администратора нет MFA.
  core = makeCore({ env: { DEMO_SIMPLE_LOGIN: 'true' } });
  app = await makeApp(core);
  // Новые аккаунты создаёт тот же сервис, что и CLI `accounts:provision`.
  origDuty = (await p().company.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })).dutyUserId;
  const r = await core.accounts.provision(ACCOUNTS);
  expect(r.accounts.every((a) => a.created)).toBe(true);
  adm = await loginByName(ACCOUNTS[0]!.login, ACCOUNTS[0]!.password);
  mgr = await loginByName(ACCOUNTS[1]!.login, ACCOUNTS[1]!.password);
  usr = await loginByName(ACCOUNTS[2]!.login, ACCOUNTS[2]!.password);
  mgrId = r.accounts[1]!.id;
  usrId = r.accounts[2]!.id;
});
afterAll(async () => {
  // общая тестовая база: возвращаем дежурного и закрываем тестовые аккаунты
  await p().company.updateMany({ data: { dutyUserId: origDuty } });
  await p().user.updateMany({ where: { login: { in: ACCOUNTS.map((a) => a.login) } }, data: { status: 'blocked' } });
  await app.close();
  await core.close();
});

describe('учётные записи: вход по логину, пароль только в виде хеша', () => {
  it('создаются как настоящие аккаунты: роли, имена, argon2-хеш, без MFA; повторный запуск обновляет, а не дублирует', async () => {
    const rows = await p().user.findMany({ where: { login: { in: ACCOUNTS.map((a) => a.login) } }, orderBy: { login: 'asc' } });
    expect(rows.map((r) => [r.role, r.fullName, r.status, r.mfaEnabled])).toEqual([
      ['ADMIN', 'Nozima Test', 'active', false],
      ['MANAGER', 'Менеджер', 'active', false],
      ['USER', 'Пользователь', 'active', false],
    ]);
    for (const r of rows) {
      expect(r.passwordHash).toMatch(/^\$argon2id\$/);
      for (const a of ACCOUNTS) expect(r.passwordHash).not.toContain(a.password);
    }
    const again = await core.accounts.provision(ACCOUNTS);
    expect(again.accounts.every((a) => !a.created)).toBe(true);
    expect(await p().user.count({ where: { login: { in: ACCOUNTS.map((a) => a.login) } } })).toBe(3);
    expect(await p().company.findFirstOrThrow({ orderBy: { createdAt: 'asc' } }).then((c) => c.dutyUserId)).toBe(rows.find((r) => r.role === 'ADMIN')!.id);
  });

  it('/me показывает роль и логин; неверный пароль и email-вход демо-аккаунтов не пересекаются', async () => {
    const me = (await mgr.get('/api/v1/me')).body;
    expect(me).toMatchObject({ login: ACCOUNTS[1]!.login, role: 'MANAGER', fullName: 'Менеджер' });
    expect(me.capabilities).not.toContain('users.manage');
    const bad = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: ACCOUNTS[1]!.login, password: 'wrong' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe('Неверный логин или пароль');
  });
});

describe('роли на сервере', () => {
  it('Пользователь: создаёт лид только на себя, ведёт свои лиды; чужие не видит; статус, продажа, переназначение и настройки закрыты на сервере', async () => {
    const own = await newLead(app, core);
    await p().lead.update({ where: { id: own.id }, data: { ownerId: usrId } });
    const other = await newLead(app, core);
    const list = (await usr.get('/api/v1/leads')).body.items as Array<{ id: string }>;
    expect(list.map((l) => l.id)).toContain(own.id);
    expect(list.map((l) => l.id)).not.toContain(other.id);
    expect((await usr.get(`/api/v1/leads/${other.id}`)).status).toBe(404);
    expect((await usr.get(`/api/v1/leads/${own.id}`)).status).toBe(200);
    // создание: автор и ответственный — сам пользователь; на чужое имя нельзя
    const created = await usr.post('/api/v1/leads', { firstName: 'Lid', lastName: 'Userdan', leadType: 'REFERRAL' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.ownerId).toBe(usrId);
    expect(created.body.leadType).toBe('REFERRAL');
    expect((await usr.post('/api/v1/leads', { firstName: 'Begona', ownerId: mgrId })).status).toBe(403);
    // свои основные данные и заметки
    expect((await usr.patch(`/api/v1/leads/${created.body.id}/contact`, { firstName: 'Lidiya' })).status).toBe(200);
    const basics = await usr.patch(`/api/v1/leads/${created.body.id}/basics`, { note: 'Qo‘ng‘iroq qilish kerak', leadType: 'REPEAT' });
    expect(basics.status).toBe(200);
    expect(basics.body).toMatchObject({ note: 'Qo‘ng‘iroq qilish kerak', leadType: 'REPEAT' });
    // чужой лид — не найден (без раскрытия)
    expect((await usr.patch(`/api/v1/leads/${other.id}/basics`, { note: 'x' })).status).toBe(404);
    expect((await usr.patch(`/api/v1/leads/${other.id}/contact`, { firstName: 'X' })).status).toBe(404);
    for (const [method, path, body] of [
      ['patch', `/api/v1/leads/${own.id}`, { version: 1, contactOutcome: 'x' }],
      ['patch', `/api/v1/leads/${own.id}/stage`, { version: 1, stage: 'LOST' }],
      ['patch', `/api/v1/leads/${own.id}/status`, { version: 1, status: 'SOLD' }],
      ['put', `/api/v1/leads/${own.id}/sale`, { serviceType: 'avia' }],
      ['post', `/api/v1/leads/${own.id}/messages`, { text: 'x' }],
      ['patch', `/api/v1/leads/${own.id}/assignee`, { userId: usrId, reason: 'x' }],
      ['post', '/api/v1/orders', { leadId: own.id }],
      ['post', '/api/v1/reminders', { title: 'x' }],
      ['post', `/api/v1/users/${mgrId}/block`, { successorId: null }],
      ['post', '/api/v1/suppliers', { name: 'x', kind: 'tour_operator' }],
    ] as const) {
      const r = await usr[method](path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.error.code).toBe('READ_ONLY_ROLE');
    }
    expect((await usr.get('/api/v1/exports/leads.csv?from=2020-01-01&to=2030-12-31')).status).toBe(403);
    expect((await usr.get('/api/v1/users')).status).toBe(403);
    expect((await usr.get('/api/v1/integrations/health')).status).toBe(403);
    const dash = await usr.get(`/api/v1/dashboard?from=2020-01-01&to=2030-12-31`);
    expect(dash.status).toBe(200);
    expect(dash.body.finance.costHidden).toBe(true);
    expect((await usr.post('/api/v1/auth/logout')).status).toBe(200); // выход разрешён
    expect((await usr.get('/api/v1/me')).status).toBe(401);
    usr = await loginByName(ACCOUNTS[2]!.login, ACCOUNTS[2]!.password);
  });

  it('Менеджер: только свои клиенты; создаёт лиды и заказы; себестоимость скрыта без отдельного разрешения; управление и выгрузка закрыты', async () => {
    const mine = await newLead(app, core);
    await p().lead.update({ where: { id: mine.id }, data: { ownerId: mgrId } });
    const other = await newLead(app, core);
    const list = (await mgr.get('/api/v1/leads')).body.items as Array<{ id: string }>;
    expect(list.map((l) => l.id)).toContain(mine.id);
    expect(list.map((l) => l.id)).not.toContain(other.id);
    expect((await mgr.get(`/api/v1/leads/${other.id}`)).status).toBe(404);
    expect((await mgr.patch(`/api/v1/leads/${other.id}`, { version: 1, contactOutcome: 'x' })).status).toBe(404);
    const created = await mgr.post('/api/v1/leads', { firstName: 'Menejer lidi' });
    expect(created.status).toBe(201);
    expect(created.body.ownerId).toBeTruthy();
    const order = await mgr.post('/api/v1/orders', { leadId: mine.id, agreedAmount: '100.00', currency: 'USD', ...{} });
    expect(order.status).toBe(201);
    const card = (await mgr.get(`/api/v1/orders/${order.body.id}`)).body;
    expect(card.canCost).toBe(false);
    expect(JSON.stringify(card)).not.toMatch(/"(profit|netAfterRefund|profitAfterRefund|supplierRefunded)":/);
    // отдельное разрешение на себестоимость, выдаваемое администратором, сохраняется
    expect((await mgr.patch(`/api/v1/users/${mgrId}/finance-access`, { enabled: true })).status).toBe(403);
    expect((await adm.patch(`/api/v1/users/${mgrId}/finance-access`, { enabled: true })).status).toBe(200);
    expect((await mgr.get('/api/v1/me')).body.capabilities).toContain('finance.cost.view');
    expect((await adm.patch(`/api/v1/users/${mgrId}/finance-access`, { enabled: false })).status).toBe(200);
    for (const path of ['/api/v1/users', '/api/v1/integrations/health', '/api/v1/exports/leads.csv?from=2020-01-01&to=2030-12-31']) expect((await mgr.get(path)).status, path).toBe(403);
    expect((await mgr.post('/api/v1/suppliers', { name: `Operator ${tag}`, kind: 'tour_operator' })).status).toBe(403);
  });

  it('Администратор: видит всех, управляет сотрудниками; список содержит логин', async () => {
    const all = await adm.get('/api/v1/leads');
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect((all.body.items as unknown[]).length).toBeGreaterThan(2);
    const users = (await adm.get('/api/v1/users')).body.items as Array<{ login: string | null; role: string }>;
    expect(users.find((u) => u.login === ACCOUNTS[0]!.login)).toMatchObject({ role: 'ADMIN' });
    expect(users.some((u) => u.role === ('HEAD' as string))).toBe(false);
    expect((await adm.get('/api/v1/integrations/health')).status).toBe(200);
    expect((await adm.get('/api/v1/exports/leads.csv?from=2020-01-01&to=2030-12-31')).status).toBe(200);
  });

  it('раздела «Дубликаты» нет: маршруты удалены; вторая заявка того же клиента не создаёт лишний контакт и лид', async () => {
    expect((await adm.get('/api/v1/duplicates')).status).toBe(404);
    expect((await adm.post('/api/v1/duplicates/00000000-0000-4000-8000-000000000000/resolve', { action: 'dismiss' })).status).toBe(404);
    const sender = `88${Date.now()}`;
    await sendDirect(app, core, { sender, text: 'Birinchi' });
    await sendDirect(app, core, { sender, text: 'Ikkinchi' });
    const mid = `mid_dup_${tag}`;
    await sendDirect(app, core, { sender, text: 'Uchinchi', mid });
    await sendDirect(app, core, { sender, text: 'Uchinchi', mid }); // повторная доставка того же события
    await drain(core);
    const conv = await p().conversation.findFirstOrThrow({ where: { scopedPeerId: sender } });
    expect(await p().lead.count({ where: { contactId: conv.contactId } })).toBe(1);
    expect(await p().message.count({ where: { conversationId: conv.id, direction: 'inbound' } })).toBe(3);
    expect(await p().contact.count({ where: { id: conv.contactId } })).toBe(1);
  });
});
