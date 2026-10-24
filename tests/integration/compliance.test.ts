import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { storeInboxEvent } from '../../apps/api/src/core/queue';
import { DEMO_STATUS_IDS, type DemoAmoRestClient, type DemoMetaLeadsClient } from '@crm/integrations';
import { companyId, drain, login, makeApp, makeCore, newLead, sendLeadAds, TestClock, userId, type Session } from './helpers';

const clock = new TestClock();
let core: Core;
let app: INestApplication;
const p = () => core.deps.prisma;
const amo = () => core.deps.adapters.amoRest({ id: '', accountDomain: null, accountId: '' }) as DemoAmoRestClient;
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

beforeAll(async () => {
  core = makeCore({ clock, env: { MAX_UPLOAD_BYTES: String(64 * 1024) } });
  app = await makeApp(core);
});
afterAll(async () => {
  await app.close();
  await core.close();
});

async function ownerSession(ownerId: string): Promise<Session> {
  return login(app, (await p().user.findUniqueOrThrow({ where: { id: ownerId } })).email);
}
async function otherManager(ownerId: string): Promise<Session> {
  const u = await p().user.findFirstOrThrow({ where: { role: 'MANAGER', id: { not: ownerId }, email: { endsWith: '@demo.local' } } });
  return login(app, u.email);
}
function upload(s: Session, q: string, body: Buffer, mime: string, name = 'pasport.pdf') {
  return request(app.getHttpServer())
    .post(`/api/v1/attachments?${q}`)
    .set('Cookie', s.cookie)
    .set('X-CSRF-Token', s.cookie.match(/crm_csrf=([^;]+)/)![1]!)
    .set('Content-Type', mime)
    .set('X-File-Name', encodeURIComponent(name))
    .send(body);
}

describe('attachments (TZ §21, AC12 files)', () => {
  it('upload → pending → scan → signed short-lived download; foreign manager gets 404 everywhere', async () => {
    clock.real();
    const lead = await newLead(app, core);
    const owner = await ownerSession(lead.ownerId!);
    const order = await owner.post('/api/v1/orders', { leadId: lead.id });
    const q = `ownerType=order&ownerId=${order.body.id}`;
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF');
    const up = await upload(owner, q, pdf, 'application/pdf', 'Shartnoma №1.pdf');
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ scanState: 'pending', mime: 'application/pdf', size: pdf.length, fileName: 'Shartnoma №1.pdf' });

    const early = await owner.post(`/api/v1/attachments/${up.body.id}/link`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('FILE_NOT_SCANNED');
    expect(await core.attachments.scanPending()).toBeGreaterThanOrEqual(1);

    const link = await owner.post(`/api/v1/attachments/${up.body.id}/link`);
    expect(link.status).toBe(200);
    const dl = await owner.get(link.body.url);
    expect(dl.status).toBe(200);
    expect(Buffer.from(dl.body).toString()).toBe(pdf.toString());
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');

    const other = await otherManager(lead.ownerId!);
    expect((await other.get(`/api/v1/attachments?${q}`)).status).toBe(404);
    expect((await other.post(`/api/v1/attachments/${up.body.id}/link`)).status).toBe(404);
    expect((await other.get(link.body.url)).status).toBe(404); // leaked URL does not work for another user
    expect((await upload(other, q, pdf, 'application/pdf')).status).toBe(404);

    clock.set(new Date(Date.now() + (core.deps.config.downloadUrlTtlSeconds + 5) * 1000));
    expect((await owner.get(link.body.url)).status).toBe(404); // expired
    clock.real();

    const head = await login(app, 'rahbar@demo.local');
    expect((await head.get(`/api/v1/attachments?${q}`)).body.items).toHaveLength(1);
    expect(await p().auditLog.count({ where: { action: { in: ['attachment_uploaded', 'attachment_downloaded'] }, entityId: order.body.id } })).toBe(2);
    expect((await request(app.getHttpServer()).delete(`/api/v1/attachments/${up.body.id}`).set('Cookie', owner.cookie).set('X-CSRF-Token', owner.cookie.match(/crm_csrf=([^;]+)/)![1]!)).status).toBe(200);
    expect((await owner.get(`/api/v1/attachments?${q}`)).body.items).toHaveLength(0);
  });

  it('rejects MIME spoofing, unsupported types and oversized files', async () => {
    const lead = await newLead(app, core);
    const owner = await ownerSession(lead.ownerId!);
    const q = `ownerType=lead&ownerId=${lead.id}`;
    const spoof = await upload(owner, q, Buffer.from('%PDF-1.4 x'), 'image/png', 'rasm.png');
    expect(spoof.status).toBe(422);
    expect(spoof.body.error.code).toBe('MIME_MISMATCH');
    const exe = await upload(owner, q, Buffer.from('MZ\x90\x00 not allowed'), 'application/octet-stream', 'x.exe');
    expect(exe.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    const big = await upload(owner, q, Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(70 * 1024)]), 'application/pdf');
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('infected file is quarantined: storage object removed, never downloadable, people notified', async () => {
    const lead = await newLead(app, core);
    const owner = await ownerSession(lead.ownerId!);
    const up = await upload(owner, `ownerType=lead&ownerId=${lead.id}`, Buffer.from(`%PDF-1.4 ${EICAR}`), 'application/pdf');
    expect(up.status).toBe(201);
    await core.attachments.scanPending();
    const row = await p().attachment.findUniqueOrThrow({ where: { id: up.body.id } });
    expect(row.scanState).toBe('infected');
    await expect(core.deps.adapters.storage.get(row.objectKey)).rejects.toThrow();
    const link = await owner.post(`/api/v1/attachments/${up.body.id}/link`);
    expect(link.body.error.code).toBe('FILE_INFECTED');
    expect(await p().notification.count({ where: { kind: 'attachment_infected', dedupeKey: { startsWith: `att_infected:${row.id}` } } })).toBeGreaterThanOrEqual(2);
  });
});

describe('SLA notifications (TZ §10)', () => {
  it('approaching → manager warning; breached → manager + head, no auto reassignment', async () => {
    clock.real();
    const lead = await newLead(app, core);
    const due = new Date(Date.now() + 60 * 60_000);
    await p().lead.update({ where: { id: lead.id }, data: { firstResponseDueAt: due } });
    clock.set(new Date(due.getTime() - 3 * 60_000));
    await core.sla.tick();
    await core.sla.tick();
    expect(await p().notification.count({ where: { kind: 'sla_warning', dedupeKey: `sla_warn:${lead.id}` } })).toBe(1);
    clock.set(new Date(due.getTime() + 60_000));
    const r = await core.sla.tick();
    expect(r.breached).toBeGreaterThanOrEqual(1);
    const after = await p().lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.slaBreachedAt).not.toBeNull();
    expect(after.ownerId).toBe(lead.ownerId); // not reassigned
    const headId = await userId(core, 'rahbar@demo.local');
    expect(await p().notification.count({ where: { kind: 'sla_breached', dedupeKey: `sla_breach:${lead.id}:${headId}` } })).toBe(1);
    expect(await p().notification.count({ where: { kind: 'sla_breached', dedupeKey: `sla_breach:${lead.id}:${lead.ownerId}` } })).toBe(1);
    await core.sla.tick();
    expect(await p().notification.count({ where: { kind: 'sla_breached', dedupeKey: { startsWith: `sla_breach:${lead.id}:` } } })).toBe(2); // once each
    clock.real();
  });

  it('a recorded human action before the deadline prevents the breach', async () => {
    clock.real();
    const lead = await newLead(app, core);
    const owner = await ownerSession(lead.ownerId!);
    await owner.patch(`/api/v1/leads/${lead.id}`, { version: lead.version, contactOutcome: 'Qo‘ng‘iroq qilindi' });
    clock.set(new Date(Date.now() + 48 * 3600_000));
    await core.sla.tick();
    expect((await p().lead.findUniqueOrThrow({ where: { id: lead.id } })).slaBreachedAt).toBeNull();
    clock.real();
  });
});

describe('retention and PII erasure (TZ §21)', () => {
  it('retention does nothing until the company confirms the policy', async () => {
    expect(await core.privacy.runRetention(companyId)).toEqual({ skipped: 'policy_not_confirmed' });
  });

  it('confirmed policy purges old raw payloads and message contents but keeps dedupe keys', async () => {
    const admin = await login(app, 'admin@demo.local');
    const head = await login(app, 'rahbar@demo.local');
    expect((await head.post('/api/v1/privacy/retention/confirm', { rawWebhookDays: 30, technicalLogDays: 90, messageContentMonths: 12 })).status).toBe(403);
    const conf = await admin.post('/api/v1/privacy/retention/confirm', { rawWebhookDays: 30, technicalLogDays: 90, messageContentMonths: 12 });
    expect(conf.body.policy).toMatchObject({ confirmed: true, rawWebhookDays: 30 });
    const key = `retention-test-${Date.now()}`;
    await storeInboxEvent(p(), core.deps.encryptionKey, { provider: 'meta', connectionKey: 'x', companyId, externalEventId: key, eventType: 'leadgen', payload: { secret: 'pii' } });
    await p().webhookInbox.updateMany({ where: { externalEventId: key }, data: { state: 'done', receivedAt: new Date(Date.now() - 40 * 86400_000) } });
    const conv = await p().conversation.findFirst({ where: { companyId } });
    if (conv) await p().message.updateMany({ where: { conversationId: conv.id }, data: { createdAt: new Date(Date.now() - 400 * 86400_000) } });
    const r = await admin.post('/api/v1/privacy/retention/run');
    expect(r.status).toBe(200);
    expect(r.body.webhookPayloadsPurged).toBeGreaterThanOrEqual(1);
    expect((await p().webhookInbox.findFirstOrThrow({ where: { externalEventId: key } })).payloadEnc).toBe('purged');
    expect(await storeInboxEvent(p(), core.deps.encryptionKey, { provider: 'meta', connectionKey: 'x', companyId, externalEventId: key, eventType: 'leadgen', payload: {} })).toBe(false);
    if (conv) expect(await p().message.count({ where: { conversationId: conv.id, content: { not: null } } })).toBe(0);
  });

  it('erasure anonymizes the person, keeps payments, flags provider copies and survives restore', async () => {
    clock.real();
    const phone = `+99894${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
    const lead = await newLead(app, core, 'Erase Valiyev', phone);
    const owner = await ownerSession(lead.ownerId!);
    const order = await owner.post('/api/v1/orders', { leadId: lead.id, agreedAmount: '300.00', currency: 'USD' });
    await owner.post(`/api/v1/orders/${order.body.id}/passengers`, { fullName: 'Erase Valiyev', type: 'adult' });
    await owner.post(`/api/v1/orders/${order.body.id}/payments`, { kind: 'payment', amount: '300.00', currency: 'USD', receivedAt: new Date().toISOString(), method: 'cash' }, { 'Idempotency-Key': `erase-pay-${lead.id}` });
    const file = await upload(owner, `ownerType=order&ownerId=${order.body.id}`, Buffer.from('%PDF-1.4 passport'), 'application/pdf');
    const fileRow = await p().attachment.findUniqueOrThrow({ where: { id: file.body.id } });

    const head = await login(app, 'rahbar@demo.local');
    expect((await head.post(`/api/v1/contacts/${lead.contactId}/erase`, { reason: 'Mijoz so‘rovi' })).status).toBe(403);
    const admin = await login(app, 'admin@demo.local');
    const r = await admin.post(`/api/v1/contacts/${lead.contactId}/erase`, { reason: 'Mijoz so‘rovi (GDPR-ga o‘xshash)' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ erased: true, providerReviewRequired: true });

    const contact = await p().contact.findUniqueOrThrow({ where: { id: lead.contactId } });
    expect(contact).toMatchObject({ fullName: 'O‘chirilgan mijoz', primaryPhone: null, primaryEmail: null });
    expect(await p().contactIdentifier.count({ where: { contactId: lead.contactId, active: true } })).toBe(0);
    expect(await p().contactIdentifier.count({ where: { value: phone } })).toBe(0);
    expect((await p().passenger.findFirstOrThrow({ where: { orderId: order.body.id } })).fullName).toBe('O‘chirilgan yo‘lovchi');
    expect(await p().payment.count({ where: { orderId: order.body.id } })).toBe(1); // financial record kept
    await expect(core.deps.adapters.storage.get(fileRow.objectKey)).rejects.toThrow();
    expect(await p().crmTask.count({ where: { kind: 'pii_provider_review', entityId: lead.id } })).toBe(1);
    expect(await p().piiTombstone.count({ where: { contactId: lead.contactId } })).toBe(1);

    // Same phone later → a new, unlinked contact (no re-identification).
    await sendLeadAds(app, core, { fullName: 'Yangi odam', phone, platform: 'ig' });
    await drain(core);
    const fresh = await p().contact.findFirstOrThrow({ where: { primaryPhone: phone } });
    expect(fresh.id).not.toBe(lead.contactId);

    // Simulated restore of an old backup: PII comes back, tombstones re-apply erasure.
    await p().contact.update({ where: { id: lead.contactId }, data: { fullName: 'Erase Valiyev', primaryPhone: phone } });
    await p().contactIdentifier.updateMany({ where: { contactId: lead.contactId }, data: { active: true } });
    const re = await core.privacy.reapplyTombstones(companyId);
    expect(re.reapplied).toBeGreaterThanOrEqual(1);
    expect((await p().contact.findUniqueOrThrow({ where: { id: lead.contactId } })).primaryPhone).toBeNull();
  });
});

describe('amoCRM initial import, reconciliation and daily control (TZ §5.2)', () => {
  it('imports active leads with contacts, resumable and idempotent; closed leads are not imported', async () => {
    clock.real();
    const aAmo = (await p().user.findUniqueOrThrow({ where: { email: 'menejer.a@demo.local' } })).amoUserId!;
    const created = [];
    for (let i = 0; i < 5; i++) created.push(await amo().simulateNativeCreate({ name: `Native ${i}`, contactName: `Native Mijoz ${i}`, phone: `+99895000000${i}`, statusId: i === 4 ? DEMO_STATUS_IDS.WON! : DEMO_STATUS_IDS.CONTACTED!, responsibleUserId: aAmo, createdAt: new Date('2026-09-01T10:00:00Z') }));
    const conn = await p().integrationConnection.findFirstOrThrow({ where: { provider: 'AMOCRM_REST' } });
    // Interrupted run: one page only, then resume.
    await core.amoSync.importInitial(companyId, { pageSize: 2, maxPages: 1 });
    const cp = await p().syncCheckpoint.findUniqueOrThrow({ where: { connectionId_stream: { connectionId: conn.id, stream: 'import:contacts' } } });
    expect((cp.cursor as { done: boolean }).done).toBe(false);
    await core.amoSync.importInitial(companyId, { pageSize: 2 });
    await core.amoSync.importInitial(companyId, { pageSize: 2 }); // re-run: nothing new
    for (const [i, c] of created.entries()) {
      const leads = await p().lead.findMany({ where: { amoLeadId: c.leadId } });
      expect(leads).toHaveLength(i === 4 ? 0 : 1);
      if (i < 4) {
        expect(leads[0]).toMatchObject({ stage: 'CONTACTED', firstSource: 'amocrm', ownerId: await userId(core, 'menejer.a@demo.local') });
        expect(leads[0]!.createdAt.toISOString()).toBe('2026-09-01T10:00:00.000Z');
      }
      expect(await p().contact.count({ where: { amoContactId: c.contactId } })).toBe(1);
    }
  });

  it('incremental reconciliation imports a lead created natively after the import', async () => {
    const conn = await p().integrationConnection.findFirstOrThrow({ where: { provider: 'AMOCRM_REST' } });
    const later = await amo().simulateNativeCreate({ name: 'Native later', contactName: 'Kech mijoz', phone: null, statusId: DEMO_STATUS_IDS.NEW!, responsibleUserId: null });
    const r = await core.amoSync.reconcile(conn);
    expect(r.leads!.created).toBeGreaterThanOrEqual(1);
    expect(await p().lead.count({ where: { amoLeadId: later.leadId } })).toBe(1);
    await core.amoSync.reconcile(conn);
    expect(await p().lead.count({ where: { amoLeadId: later.leadId } })).toBe(1);
  });

  it('daily control tombstones leads that vanished from amoCRM and never re-creates them', async () => {
    const lead = await newLead(app, core);
    await amo().simulateHardDelete(lead.amoLeadId!);
    const conn = await p().integrationConnection.findFirstOrThrow({ where: { provider: 'AMOCRM_REST' } });
    const r = await core.amoSync.dailyAudit(conn);
    expect(r.tombstoned).toBeGreaterThanOrEqual(1);
    expect((await p().lead.findUniqueOrThrow({ where: { id: lead.id } })).deletedAt).not.toBeNull();
    expect(await p().outboxOperation.count({ where: { action: 'lead.create', payload: { path: ['leadId'], equals: lead.id } } })).toBe(1);
    expect(await core.amoSync.dailyAuditIfDue(conn)).toBeNull(); // at most once per 24 h
  });
});

describe('Lead Ads history re-fetch (TZ §8.3)', () => {
  it('paginates, checkpoints, dedupes with webhook deliveries and reports gaps', async () => {
    clock.real();
    const formId = `form_bf_${Date.now()}`;
    const company = await p().company.findUniqueOrThrow({ where: { id: companyId } });
    await p().company.update({ where: { id: companyId }, data: { settings: { ...(company.settings as object), leadForms: { [formId]: { instagramOnly: true } } } } });
    const leads = core.deps.adapters.metaLeads as DemoMetaLeadsClient;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `bf_${formId}_${i}`;
      ids.push(id);
      await leads.registerLead({ leadgenId: id, createdTime: new Date(Date.now() - (10 - i) * 3600_000), formId, adId: null, adsetId: null, campaignId: null, platform: null, fields: { full_name: `Backfill ${i}`, phone_number: `+9989600000${i}` } });
    }
    // Lead #0 already arrived by webhook.
    const before = await sendLeadAds(app, core, { fullName: 'Backfill 0', phone: '+99896000000', leadgenId: ids[0] });
    expect(before.res.status).toBe(200);
    await drain(core);

    const r = await core.leadAdsBackfill.run(companyId, { since: new Date(Date.now() - 24 * 3600_000), pageSize: 2 });
    const stat = r.forms.find((f) => f.formId === formId)!;
    expect(stat).toMatchObject({ fetched: 5, newEvents: 4, duplicates: 1, gap: null });
    expect(stat.pages).toBe(3);
    await drain(core);
    for (const id of ids) expect(await p().inquiry.count({ where: { providerEventKey: `meta_leads:${id}` } })).toBe(1);
    const inq = await p().inquiry.findFirstOrThrow({ where: { providerEventKey: `meta_leads:${ids[3]}` } });
    expect(inq).toMatchObject({ channel: 'instagram_lead_ads', placement: 'instagram_form_mapping' });

    const again = await core.leadAdsBackfill.run(companyId, { pageSize: 2 });
    expect(again.forms.find((f) => f.formId === formId)).toMatchObject({ fetched: 0, newEvents: 0 });

    const old = await core.leadAdsBackfill.run(companyId, { since: new Date(Date.now() - 400 * 86400_000), pageSize: 2 });
    expect(old.forms.find((f) => f.formId === formId)!.gap).toMatchObject({ reason: 'outside_retrieval_window' });
  });

  it('API: backfill and import are queued operations visible to admins only', async () => {
    const admin = await login(app, 'admin@demo.local');
    const mgr = await login(app, 'menejer.a@demo.local');
    expect((await mgr.post('/api/v1/integrations/lead-ads/backfill', {})).status).toBe(403);
    const r = await admin.post('/api/v1/integrations/lead-ads/backfill', {});
    expect(r.status).toBe(202);
    await drain(core);
    expect((await p().outboxOperation.findUniqueOrThrow({ where: { id: r.body.operationId } })).state).toBe('done');
    const imp = await admin.post('/api/v1/integrations/amocrm/import');
    expect(imp.status).toBe(202);
    await drain(core);
    expect((await p().outboxOperation.findUniqueOrThrow({ where: { id: imp.body.operationId } })).state).toBe('done');
    const health = await admin.get('/api/v1/integrations/health');
    expect(health.body.checkpoints.some((c: { stream: string }) => c.stream.startsWith('leadforms:'))).toBe(true);
    expect(health.body.retention.status).toBe('active');
  });
});
