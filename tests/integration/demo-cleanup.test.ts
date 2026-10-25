import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { createPrisma } from '../../packages/database/src';
import { restoreAndVerify, type ExportFile } from '../../scripts/demo-cleanup/verify-export';
import { alwaysOnDuty, drain, login, makeApp, makeCore, newLead, type Session } from './helpers';

/**
 * Demo tozalash: reja → mantiqiy eksport → ALOHIDA bazaga tiklash tekshiruvi → hash bilan o'chirish.
 * Ajratilgan vaqtinchalik baza ishlatiladi (boshqa test fayllari ma'lumotiga tegmaslik uchun).
 */
const root = join(__dirname, '..', '..');
let dbName = '';
let adminDb: ReturnType<typeof createPrisma>;
let core: Core;
let app: INestApplication;
let admin: Session;
let head: Session;
let mgr: Session;
const p = () => core.deps.prisma;

async function withEnv(fn: () => Promise<void>) {
  const base = process.env.TEST_DATABASE_URL!;
  dbName = `crm_cleanup_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  adminDb = createPrisma(base);
  await adminDb.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  const env = { ...process.env, DATABASE_URL: url.toString(), APP_MODE: 'demo' };
  execSync('npx prisma migrate deploy', { cwd: root, env, stdio: 'pipe' });
  execSync('npx tsx --conditions=development packages/database/src/seed.ts', { cwd: root, env, stdio: 'pipe' });
  core = makeCore({ env: { DATABASE_URL: url.toString() } });
  await alwaysOnDuty(core);
  app = await makeApp(core);
  admin = await login(app, 'admin@demo.local');
  head = await login(app, 'rahbar@demo.local');
  mgr = await login(app, 'menejer.a@demo.local');
  try {
    await fn();
  } finally {
    await app.close();
    await core.close();
    await adminDb.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminDb.$disconnect();
  }
}

async function makeReal(label: string) {
  const company = await p().company.findFirstOrThrow();
  let conn = await p().integrationConnection.findFirst({ where: { provider: 'META_DIRECT', mode: 'live' } });
  conn ??= await p().integrationConnection.create({ data: { companyId: company.id, provider: 'META_DIRECT', mode: 'live', accountId: 'REAL_ACC_1', routeToken: `rt-${Date.now()}`, health: 'degraded', healthReason: 'awaiting_live_verification', settings: {} } });
  const contact = await p().contact.create({ data: { companyId: company.id, fullName: null, instagramUsername: `real_${label}`, syncState: 'pending_create' } });
  await p().contactIdentifier.create({ data: { companyId: company.id, contactId: contact.id, type: 'instagram_scoped', value: `IGS_${label}`, scope: conn.accountId, verified: true } });
  const lead = await p().$transaction((tx) => core.leads.createLead(tx, { companyId: company.id, contactId: contact.id, name: `@real_${label}`, channel: 'instagram_direct', placement: 'instagram', inquiryId: null, serviceType: null, at: new Date(), actor: { type: 'system', companyId: company.id, name: 'test' } as never }));
  const conv = await p().conversation.create({ data: { companyId: company.id, connectionId: conn.id, businessAccountId: conn.accountId, scopedPeerId: `IGS_${label}`, contactId: contact.id, leadId: lead.id } });
  await p().message.create({ data: { companyId: company.id, conversationId: conv.id, connectionId: conn.id, providerMessageId: `mid_${label}`, direction: 'inbound', type: 'text', content: 'haqiqiy xabar', attachments: [], state: 'received', actorType: 'customer' } });
  await p().crmTask.create({ data: { companyId: company.id, automationKey: `real_task_${label}`, entityType: 'lead', entityId: lead.id, kind: 'follow_up', text: 'haqiqiy lid vazifasi', dueAt: new Date(), state: 'pending' } });
  const u = await p().user.findFirstOrThrow({ where: { role: 'HEAD' } });
  await p().notification.create({ data: { companyId: company.id, userId: u.id, kind: 'lead_assigned', dedupeKey: `real_n_${label}`, title: 'Haqiqiy lid', link: `/leads/${lead.id}` } });
  await p().outboxOperation.create({ data: { companyId: company.id, operationKey: `real_op_${label}`, target: 'amocrm', action: 'lead.create', payload: { leadId: lead.id }, state: 'done', correlationId: `c_${label}` } });
  await p().webhookInbox.create({ data: { companyId: company.id, provider: 'meta', connectionKey: conn.accountId, externalEventId: `ig_msg:${label}`, eventType: 'ig_message', payloadEnc: 'x', state: 'done', correlationId: `c_${label}` } });
  return { contact, lead, conv };
}

const counts = async () => ({
  contacts: await p().contact.count(),
  leads: await p().lead.count(),
  orders: await p().order.count(),
  conversations: await p().conversation.count(),
  messages: await p().message.count(),
  users: await p().user.count(),
  connections: await p().integrationConnection.count(),
  auditLogs: await p().auditLog.count(),
  tasks: await p().crmTask.count(),
});

describe('demo tozalash: eksport → tiklash tekshiruvi → o‘chirish', () => {
  it('buyurtmasi bor, TO‘LOVSIZ sun’iy (Lead Ads demo) yozuvlar eksport qilinadi, alohida bazaga to‘liq tiklanadi va faqat ular o‘chiriladi; haqiqiy/noaniq/yangi kelgan saqlanadi', () => withEnv(async () => {
    // Sun'iy: 3 ta Lead Ads lidi (+ buyurtma va to'lov)
    const demoLeads = [await newLead(app, core), await newLead(app, core), await newLead(app, core)];
    const order = (await head.post('/api/v1/orders', { leadId: demoLeads[0]!.id, agreedAmount: '500.00', currency: 'USD' })).body;
    await drain(core);
    // Haqiqiy va noaniq
    const real = await makeReal('a');
    const manual = (await head.post('/api/v1/leads', { firstName: 'Qo‘lda', lastName: 'Kiritilgan' })).body;
    await drain(core);

    // 1) Reja
    expect((await mgr.get('/api/v1/admin/maintenance/demo-cleanup/plan')).status).toBe(403);
    const plan = (await admin.get('/api/v1/admin/maintenance/demo-cleanup/plan')).body;
    expect(plan.delete.leads.map((l: { id: string }) => l.id).sort()).toEqual(demoLeads.map((l) => l.id).sort());
    expect(plan.delete.orders).toHaveLength(1);
    expect(plan.keep.realLeads.map((l: { id: string }) => l.id)).toEqual([real.lead.id]);
    expect(plan.keep.uncertain.leads.map((l: { id: string }) => l.id)).toContain(manual.id);
    expect(plan.delete.rowsPerTable.payments).toBe(0);

    // 2) Eksport (to'liq) va uning ichki izchilligi
    expect((await mgr.get('/api/v1/admin/maintenance/demo-cleanup/export')).status).toBe(403);
    const exp = (await admin.get('/api/v1/admin/maintenance/demo-cleanup/export')).body as ExportFile & { sets: { leads: string[] } };
    expect(exp.manifestHash).toBe(plan.manifestHash);
    expect(exp.counts).toEqual(plan.delete.rowsPerTable);
    expect(exp.tables.find((t) => t.table === 'leads')!.count).toBe(3);
    expect(exp.tables.find((t) => t.table === 'orders')!.count).toBe(1);
    expect(exp.tables.find((t) => t.table === 'notifications')!.count).toBeGreaterThan(0);
    expect(exp.tables.find((t) => t.table === 'outbox_operations')!.count).toBeGreaterThan(0);
    expect(Object.values(exp.integrity ?? {}).every((v) => v.missing.length === 0)).toBe(true);
    // Haqiqiy yozuvlar eksportda YO'Q
    const exportedIds = JSON.stringify(exp.tables.map((t) => t.rows));
    for (const id of [real.lead.id, real.contact.id, real.conv.id, manual.id]) expect(exportedIds).not.toContain(id);

    // 3) Alohida vaqtinchalik bazaga tiklash va qatorma-qator solishtirish
    const verify = await restoreAndVerify(exp, process.env.TEST_DATABASE_URL!, root);
    expect(verify.problems).toEqual([]);
    expect(verify.ok).toBe(true);
    expect(verify.tables.every((t) => t.identical)).toBe(true);

    // 4) Himoya: noto'g'ri tasdiq / noto'g'ri hash / ruxsatsiz
    const before = await counts();
    expect((await mgr.post('/api/v1/admin/maintenance/demo-cleanup/execute', { manifestHash: exp.manifestHash, confirm: 'DELETE-DEMO-RECORDS' })).status).toBe(403);
    expect((await admin.post('/api/v1/admin/maintenance/demo-cleanup/execute', { manifestHash: exp.manifestHash, confirm: 'ha' })).status).toBe(422);
    expect((await admin.post('/api/v1/admin/maintenance/demo-cleanup/execute', { manifestHash: 'x'.repeat(64), confirm: 'DELETE-DEMO-RECORDS' })).status).toBe(409);
    expect(await counts()).toEqual(before); // hech narsa o'chirilmadi

    // 5) Eksportdan keyin yangi HAQIQIY lid keldi (hash o'zgarmaydi) — o'chirish paytida saqlanishi shart
    const late = await makeReal('late');
    const snap = async (r: { lead: { id: string }; conv: { id: string } }) => ({
      tasks: await p().crmTask.count({ where: { entityId: r.lead.id } }),
      notifs: await p().notification.count({ where: { link: `/leads/${r.lead.id}` } }),
      ops: await p().outboxOperation.count({ where: { payload: { path: ['leadId'], equals: r.lead.id } } }),
      msgs: await p().message.count({ where: { conversationId: r.conv.id } }),
    });
    const keepBefore = { real: await snap(real), late: await snap(late) };
    const run = await admin.post('/api/v1/admin/maintenance/demo-cleanup/execute', { manifestHash: exp.manifestHash, confirm: 'DELETE-DEMO-RECORDS' });
    expect(run.status).toBe(200);
    expect(run.body.deleted).toEqual(exp.counts);

    // 6) Natija: sun'iy yo'q; haqiqiy, noaniq, yangi kelgan, xodim, ulanish, audit saqlangan
    for (const l of demoLeads) expect(await p().lead.findUnique({ where: { id: l.id } })).toBeNull();
    expect(await p().order.count({ where: { id: order.id } })).toBe(0);
    for (const r of [real, late]) {
      expect(await p().lead.findUnique({ where: { id: r.lead.id } })).not.toBeNull();
      expect(await p().contact.findUnique({ where: { id: r.contact.id } })).not.toBeNull();
      expect(await p().conversation.count({ where: { id: r.conv.id } })).toBe(1);
      expect(await snap(r)).toEqual(r === real ? keepBefore.real : keepBefore.late); // vazifa, bildirishnoma, outbox va xabarlar to'liq saqlangan
      expect((await snap(r)).tasks).toBeGreaterThanOrEqual(1);
    }
    expect(await p().lead.findUnique({ where: { id: manual.id } })).not.toBeNull();
    const after = await counts();
    expect(after.users).toBe(before.users);
    expect(after.connections).toBe(before.connections + 0); // jonli ulanish makeReal('a') da yaratilgan, 'late' qayta ishlatadi
    expect(after.conversations).toBe(before.conversations + 1);
    expect(after.messages).toBe(before.messages + 1);
    expect(after.auditLogs).toBeGreaterThanOrEqual(before.auditLogs + 1); // o'chirish audit'i qo'shildi, hech narsa o'chmadi
    expect(await p().auditLog.count({ where: { action: 'demo_cleanup_executed' } })).toBe(1);

    // 7) Takroriy ishga tushirish xavfsiz: endi o'chiradigan narsa yo'q
    const again = (await admin.get('/api/v1/admin/maintenance/demo-cleanup/plan')).body;
    expect(again.delete.leads).toHaveLength(0);
    // Dashboard ko'rsatkichlari sun'iy yozuvlarsiz hisoblanadi
    const dash = await admin.get('/api/v1/dashboard?from=2020-01-01&to=2035-12-31');
    expect(dash.status).toBe(200);
    expect(JSON.stringify(dash.body)).not.toContain(order.id); // sun'iy buyurtma ko'rsatkichlarda qolmadi
  }));

  it('sun’iy to‘lov bor bo‘lsa: bazaning moliyaviy himoyasi (to‘lovni o‘chirib bo‘lmaydi) hammasini bekor qiladi — hech narsa o‘chmaydi, aniq xabar qaytadi', () =>
    withEnv(async () => {
      const lead = await newLead(app, core);
      const order = (await head.post('/api/v1/orders', { leadId: lead.id, agreedAmount: '500.00', currency: 'USD' })).body;
      expect((await head.post(`/api/v1/orders/${order.id}/payments`, { kind: 'payment', amount: '100.00', currency: 'USD', receivedAt: new Date().toISOString(), method: 'cash' }, { 'Idempotency-Key': `cl2-${order.id}` })).status).toBe(201);
      await drain(core);
      const real = await makeReal('b');
      const exp = (await admin.get('/api/v1/admin/maintenance/demo-cleanup/export')).body as ExportFile;
      expect(exp.tables.find((t) => t.table === 'payments')!.count).toBe(1);
      expect((await restoreAndVerify(exp, process.env.TEST_DATABASE_URL!, root)).ok).toBe(true);
      const before = await counts();
      const run = await admin.post('/api/v1/admin/maintenance/demo-cleanup/execute', { manifestHash: exp.manifestHash, confirm: 'DELETE-DEMO-RECORDS' });
      expect(run.status).toBe(409);
      expect(run.body.error.code).toBe('PAYMENTS_PROTECTED');
      expect(await counts()).toEqual(before); // tranzaksiya to'liq bekor qilindi
      expect(await p().lead.findUnique({ where: { id: lead.id } })).not.toBeNull();
      expect(await p().payment.count({ where: { orderId: order.id } })).toBe(1);
      expect(await p().lead.findUnique({ where: { id: real.lead.id } })).not.toBeNull();
      const guard = async () => (await p().$queryRawUnsafe<Array<{ tgenabled: string }>>(`SELECT tgenabled::text AS tgenabled FROM pg_trigger WHERE tgname = 'payments_no_delete' AND tgrelid = 'payments'::regclass`))[0]?.tgenabled;
      expect(await guard()).toBe('O');

      // Rollback: o'chirilmaydigan buyurtma demo lidga havola qiladi -> FK xatosi; to'lov o'chirilgan bo'lsa ham hammasi qaytadi, trigger yoqilgan
      const keeper = (await head.post('/api/v1/leads', { firstName: 'Saqlanadi' })).body;
      const keepOrder = (await head.post('/api/v1/orders', { leadId: keeper.id, agreedAmount: '10.00', currency: 'USD' })).body;
      await p().order.update({ where: { id: keepOrder.id }, data: { contactId: lead.contactId } }); // o'chirilmaydigan buyurtma demo KONTAKTga havola qiladi
      const exp2 = (await admin.get('/api/v1/admin/maintenance/demo-cleanup/export')).body as ExportFile;
      const before2 = await counts();
      const rb = await admin.post('/api/v1/admin/maintenance/demo-cleanup/execute', { manifestHash: exp2.manifestHash, confirm: 'DELETE-DEMO-RECORDS', allowPaymentDeletion: 'DELETE-DEMO-PAYMENTS' });
      expect(rb.status).toBe(409);
      expect(['DELETE_BLOCKED_BY_REFERENCE', 'DELETE_COUNT_MISMATCH']).toContain(rb.body.error.code);
      expect(await counts()).toEqual(before2);
      expect(await p().payment.count({ where: { orderId: order.id } })).toBe(1);
      expect(await guard()).toBe('O');
    }));

  it('to‘lov himoyasi aniq so‘ralganda faqat shu tranzaksiyada ochiladi: sun’iy to‘lov o‘chadi, trigger qayta yoqiladi, boshqa to‘lov hamon o‘chmaydi, haqiqiy yozuvlar saqlanadi', () =>
    withEnv(async () => {
      const lead = await newLead(app, core);
      const order = (await head.post('/api/v1/orders', { leadId: lead.id, agreedAmount: '500.00', currency: 'USD' })).body;
      expect((await head.post(`/api/v1/orders/${order.id}/payments`, { kind: 'payment', amount: '100.00', currency: 'USD', receivedAt: new Date().toISOString(), method: 'cash' }, { 'Idempotency-Key': `cl3-${order.id}` })).status).toBe(201);
      const real = await makeReal('c');
      // Noaniq (qo'lda) lid va uning to'lovi: o'chirilmasligi va himoyasi saqlanishi kerak
      const keeper = (await head.post('/api/v1/leads', { firstName: 'Saqlanadigan' })).body;
      const keepOrder = (await head.post('/api/v1/orders', { leadId: keeper.id, agreedAmount: '70.00', currency: 'USD' })).body;
      expect((await head.post(`/api/v1/orders/${keepOrder.id}/payments`, { kind: 'payment', amount: '20.00', currency: 'USD', receivedAt: new Date().toISOString(), method: 'cash' }, { 'Idempotency-Key': `cl3k-${keepOrder.id}` })).status).toBe(201);
      await drain(core);
      const exp = (await admin.get('/api/v1/admin/maintenance/demo-cleanup/export')).body as ExportFile;
      expect(exp.tables.find((t) => t.table === 'payments')!.count).toBe(1);
      const run = await admin.post('/api/v1/admin/maintenance/demo-cleanup/execute', { manifestHash: exp.manifestHash, confirm: 'DELETE-DEMO-RECORDS', allowPaymentDeletion: 'DELETE-DEMO-PAYMENTS' });
      expect(run.status).toBe(200);
      expect(run.body.deleted.payments).toBe(1);
      expect(await p().payment.count({ where: { orderId: order.id } })).toBe(0);
      expect(await p().lead.findUnique({ where: { id: lead.id } })).toBeNull();
      // Trigger qayta yoqilgan va ishlaydi
      const trg = await p().$queryRawUnsafe<Array<{ tgenabled: string }>>(`SELECT tgenabled::text AS tgenabled FROM pg_trigger WHERE tgname = 'payments_no_delete' AND tgrelid = 'payments'::regclass`);
      expect(trg[0]?.tgenabled).toBe('O');
      await expect(p().$executeRawUnsafe(`DELETE FROM payments WHERE order_id = '${keepOrder.id}'`)).rejects.toThrow(/payments cannot be deleted/);
      expect(await p().payment.count({ where: { orderId: keepOrder.id } })).toBe(1);
      expect(await p().lead.findUnique({ where: { id: real.lead.id } })).not.toBeNull();
      expect(await p().message.count({ where: { conversationId: real.conv.id } })).toBe(1);
      expect(await p().lead.findUnique({ where: { id: keeper.id } })).not.toBeNull();
    }));
});
