import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { drain, login, makeApp, makeCore, newLead, userId, type Session } from './helpers';

let core: Core;
let app: INestApplication;
let a: Session;
let b: Session;
let head: Session;

beforeAll(async () => {
  core = makeCore();
  app = await makeApp(core);
  a = await login(app, 'menejer.a@demo.local');
  b = await login(app, 'menejer.b@demo.local');
  head = await login(app, 'rahbar@demo.local');
});
afterAll(async () => {
  await app.close();
  await core.close();
});

async function leadOwnedBy(email: string) {
  const owner = await userId(core, email);
  for (let i = 0; i < 6; i++) {
    const lead = await newLead(app, core);
    if (lead.ownerId === owner) return lead;
  }
  throw new Error('round robin did not reach owner');
}

describe('authentication', () => {
  it('rejects wrong password and unknown user identically', async () => {
    const r1 = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'menejer.a@demo.local', password: 'wrong-password' });
    const r2 = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'nobody@demo.local', password: 'wrong-password' });
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(r1.body.error.code).toBe(r2.body.error.code);
  });

  it('admin login requires TOTP', async () => {
    const r = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'admin@demo.local', password: 'Demo-parol-2026!' });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('MFA_REQUIRED');
  });

  it('mutations without CSRF header are rejected', async () => {
    const r = await request(app.getHttpServer()).post('/api/v1/orders').set('Cookie', a.cookie).send({ leadId: '00000000-0000-4000-8000-000000000999' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CSRF_FAILED');
  });

  it('no session → 401 with error shape and request id', async () => {
    const r = await request(app.getHttpServer()).get('/api/v1/leads');
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: { code: 'UNAUTHORIZED' }, request_id: expect.any(String) });
  });

  it('invite → activate → login; blocked user loses session immediately', async () => {
    const admin = await login(app, 'admin@demo.local');
    const inv = await admin.post('/api/v1/users', { email: `new${Date.now()}@demo.local`, fullName: 'Yangi Xodim', role: 'MANAGER', amoUserId: null });
    expect(inv.status).toBe(201);
    const token = new URL(inv.body.activationUrl).searchParams.get('token');
    expect((await request(app.getHttpServer()).post('/api/v1/auth/activate').send({ token, password: 'short' })).status).toBe(422);
    expect((await request(app.getHttpServer()).post('/api/v1/auth/activate').send({ token, password: 'Uzun-va-xavfsiz-parol-1' })).status).toBe(200);
    expect((await request(app.getHttpServer()).post('/api/v1/auth/activate').send({ token, password: 'Uzun-va-xavfsiz-parol-1' })).status).toBe(422);
    const user = await core.deps.prisma.user.findUniqueOrThrow({ where: { id: inv.body.userId } });
    const loginRes = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: user.email, password: 'Uzun-va-xavfsiz-parol-1' });
    expect(loginRes.status).toBe(200);
    const cookie = (loginRes.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    expect((await request(app.getHttpServer()).get('/api/v1/me').set('Cookie', cookie)).status).toBe(200);
    expect((await admin.post(`/api/v1/users/${user.id}/block`, { successorId: null })).status).toBe(200);
    expect((await request(app.getHttpServer()).get('/api/v1/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('managers cannot manage users', async () => {
    expect((await a.get('/api/v1/users')).status).toBe(403);
  });
});

describe('object-level RBAC (AC12)', () => {
  it('manager B cannot read manager A lead, contact, order; gets 404 not 403', async () => {
    const lead = await leadOwnedBy('menejer.a@demo.local');
    expect((await a.get(`/api/v1/leads/${lead.id}`)).status).toBe(200);
    expect((await b.get(`/api/v1/leads/${lead.id}`)).status).toBe(404);
    expect((await b.get(`/api/v1/contacts/${lead.contactId}`)).status).toBe(404);
    const order = await a.post('/api/v1/orders', { leadId: lead.id, agreedAmount: '1000.00', currency: 'USD' });
    expect(order.status).toBe(201);
    expect((await b.get(`/api/v1/orders/${order.body.id}`)).status).toBe(404);
    expect((await b.patch(`/api/v1/orders/${order.body.id}`, { version: 1, note: 'x' })).status).toBe(404);
    expect((await b.post(`/api/v1/orders/${order.body.id}/payments`, { kind: 'payment', amount: '1.00', currency: 'USD', receivedAt: new Date().toISOString(), method: 'cash' }, { 'Idempotency-Key': 'rbac-test-key-1' })).status).toBe(404);
    expect((await b.post('/api/v1/orders', { leadId: lead.id })).status).toBe(404);
    expect((await head.get(`/api/v1/orders/${order.body.id}`)).status).toBe(200);
  });

  it('lists, dashboard and flights are scoped to the manager', async () => {
    const bId = await userId(core, 'menejer.b@demo.local');
    const list = await b.get('/api/v1/leads?limit=200');
    expect(list.status).toBe(200);
    expect(list.body.items.every((l: { ownerId: string }) => l.ownerId === bId)).toBe(true);
    const flights = await b.get('/api/v1/flights');
    expect(flights.body.items.every((s: { ownerId: string }) => s.ownerId === bId)).toBe(true);
    const aId = await userId(core, 'menejer.a@demo.local');
    const dash = await b.get(`/api/v1/dashboard?from=2020-01-01&to=2030-12-31&ownerId=${aId}`);
    expect(dash.status).toBe(200);
    expect(dash.body.managers.every((m: { userId: string | null }) => m.userId === bId || m.userId === null)).toBe(true);
  });

  it('export is denied to managers and audited for heads', async () => {
    expect((await b.get('/api/v1/exports/leads.csv?from=2020-01-01&to=2030-12-31')).status).toBe(403);
    const r = await head.get('/api/v1/exports/leads.csv?from=2020-01-01&to=2030-12-31');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    const auditRow = await core.deps.prisma.auditLog.findFirst({ where: { action: 'leads_csv' }, orderBy: { createdAt: 'desc' } });
    expect(auditRow).not.toBeNull();
  });

  it('manager cannot reassign; head can (pending until amoCRM confirms)', async () => {
    const lead = await leadOwnedBy('menejer.a@demo.local');
    const bId = await userId(core, 'menejer.b@demo.local');
    expect((await a.patch(`/api/v1/leads/${lead.id}/assignee`, { userId: bId, reason: 'x' })).status).toBe(403);
    const r = await head.patch(`/api/v1/leads/${lead.id}/assignee`, { userId: bId, reason: 'yuklama' });
    expect(r.status).toBe(202);
    expect(r.body.syncState).toBe('pending');
    await drain(core);
    const after = await core.deps.prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.ownerId).toBe(bId);
    expect(after.pendingChange).toBeNull();
    // Old owner loses access immediately after the change.
    expect((await a.get(`/api/v1/leads/${lead.id}`)).status).toBe(404);
    expect((await b.get(`/api/v1/leads/${lead.id}`)).status).toBe(200);
  });

  it('malformed ids return 404', async () => {
    expect((await a.get('/api/v1/leads/not-a-uuid')).status).toBe(404);
  });
});

describe('audit immutability', () => {
  it('UPDATE and DELETE on audit_logs are rejected by the database', async () => {
    const row = await core.deps.prisma.auditLog.findFirstOrThrow();
    await expect(core.deps.prisma.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(core.deps.prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });

  it('cross-company references are impossible at the FK level', async () => {
    const other = await core.deps.prisma.company.create({ data: { name: 'Boshqa kompaniya', workSchedule: { timezone: 'Asia/Tashkent', days: {} } } });
    const lead = await core.deps.prisma.lead.findFirstOrThrow();
    await expect(
      core.deps.prisma.offer.create({ data: { companyId: other.id, leadId: lead.id, offerNo: 'X', version: 1, content: 'x', amountMinor: 1n, currency: 'USD', createdById: lead.ownerId! } }),
    ).rejects.toThrow();
  });
});

describe('drain helper sanity', () => {
  it('drain terminates', async () => {
    await drain(core);
  });
});
