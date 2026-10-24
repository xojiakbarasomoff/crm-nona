import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { DemoMetaDirectClient, signMetaBody } from '@crm/integrations';
import { drain, login, makeApp, makeCore, sendChatReply, sendDirect, sendLeadAds, testConfig } from './helpers';
import { createApp } from '../../apps/api/src/app';
import { createCore } from '../../apps/api/src/core';

let core: Core;
let app: INestApplication;

beforeAll(async () => {
  core = makeCore();
  app = await makeApp(core);
});
afterAll(async () => {
  await app.close();
  await core.close();
});

const p = () => core.deps.prisma;
const phone = () => `+99891${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

describe('Lead Ads (AC01, AC02, AC09)', () => {
  it('AC01: one inquiry, contact, lead with correct source and owner; amoCRM lead + first-contact task', async () => {
    const ph = phone();
    const { res, leadgenId } = await sendLeadAds(app, core, { fullName: 'Ali Valiyev', phone: ph, platform: 'ig' });
    expect(res.status).toBe(200);
    await drain(core);
    const inquiry = await p().inquiry.findFirstOrThrow({ where: { providerEventKey: `meta_leads:${leadgenId}` } });
    expect(inquiry).toMatchObject({ channel: 'instagram_lead_ads', placement: 'instagram', processingState: 'linked' });
    const lead = await p().lead.findUniqueOrThrow({ where: { id: inquiry.leadId! } });
    expect(lead).toMatchObject({ stage: 'NEW', firstSource: 'instagram_lead_ads', syncState: 'synced', assignmentReason: 'round_robin' });
    expect(lead.ownerId).not.toBeNull();
    expect(lead.amoLeadId).not.toBeNull();
    const contact = await p().contact.findUniqueOrThrow({ where: { id: lead.contactId } });
    expect(contact.primaryPhone).toBe(ph);
    const tasks = await p().crmTask.findMany({ where: { entityId: lead.id, kind: 'first_contact' } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.amoTaskId).not.toBeNull();
  });

  it('page leadgen without explicit platform stays meta_lead_ads / unknown placement', async () => {
    const { leadgenId } = await sendLeadAds(app, core, { fullName: 'Noma’lum Joy', phone: phone(), platform: null });
    await drain(core);
    const inquiry = await p().inquiry.findFirstOrThrow({ where: { providerEventKey: `meta_leads:${leadgenId}` } });
    expect(inquiry).toMatchObject({ channel: 'meta_lead_ads', placement: 'unknown' });
  });

  it('AC02: the same event delivered 10 times creates one inquiry, one lead, one task', async () => {
    const ph = phone();
    const first = await sendLeadAds(app, core, { fullName: 'Takror Mijoz', phone: ph, platform: 'ig' });
    const srv = app.getHttpServer();
    const sig = signMetaBody(first.body, core.deps.config.meta.appSecret);
    await Promise.all(Array.from({ length: 9 }, () => request(srv).post('/webhooks/meta').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(first.body.toString())));
    await drain(core);
    const inquiries = await p().inquiry.findMany({ where: { providerEventKey: `meta_leads:${first.leadgenId}` } });
    expect(inquiries).toHaveLength(1);
    const leads = await p().lead.findMany({ where: { contactId: inquiries[0]!.contactId! } });
    expect(leads).toHaveLength(1);
    expect(await p().crmTask.count({ where: { entityId: leads[0]!.id, kind: 'first_contact' } })).toBe(1);
    expect(await p().webhookInbox.count({ where: { externalEventId: `leadgen:${first.leadgenId}` } })).toBe(1);
  });

  it('repeat inquiry from same contact attaches to the active lead (TZ §7.3)', async () => {
    const ph = phone();
    await sendLeadAds(app, core, { fullName: 'Qayta Murojaat', phone: ph, platform: 'ig' });
    await drain(core);
    await sendLeadAds(app, core, { fullName: 'Qayta Murojaat', phone: ph, platform: 'ig' });
    await drain(core);
    const contact = await p().contact.findFirstOrThrow({ where: { primaryPhone: ph } });
    expect(await p().lead.count({ where: { contactId: contact.id } })).toBe(1);
    expect(await p().inquiry.count({ where: { contactId: contact.id } })).toBe(2);
  });

  it('AC09: campaign metadata failure does not block the lead; enrichment error is visible', async () => {
    await core.deps.adapters.demoStore!.injectFailure('meta_adnames', 'validation');
    const { leadgenId } = await sendLeadAds(app, core, { fullName: 'Enrich Fail', phone: phone(), platform: 'ig', adId: '120000000000777' });
    await drain(core);
    const inquiry = await p().inquiry.findFirstOrThrow({ where: { providerEventKey: `meta_leads:${leadgenId}` } });
    expect(inquiry.leadId).not.toBeNull();
    expect(inquiry.enrichmentState).toBe('failed');
    expect(inquiry.enrichmentError).toContain('400');
    const op = await p().outboxOperation.findFirstOrThrow({ where: { operationKey: `inquiry.enrich:${inquiry.id}` } });
    expect(op.state).toBe('dead');
  });

  it('invalid signature is rejected and nothing is stored', async () => {
    const body = JSON.stringify({ object: 'page', entry: [{ id: '1', changes: [{ field: 'leadgen', value: { leadgen_id: 'evil' } }] }] });
    const r = await request(app.getHttpServer()).post('/webhooks/meta').set('Content-Type', 'application/json').set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64)).send(body);
    expect(r.status).toBe(401);
    expect(await p().webhookInbox.count({ where: { externalEventId: 'leadgen:evil' } })).toBe(0);
  });

  it('GET verification uses the verify token, separate from payload signatures', async () => {
    const ok = await request(app.getHttpServer()).get('/webhooks/meta').query({ 'hub.mode': 'subscribe', 'hub.verify_token': core.deps.config.meta.verifyToken, 'hub.challenge': '12345' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('12345');
    const bad = await request(app.getHttpServer()).get('/webhooks/meta').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' });
    expect(bad.status).toBe(403);
  });
});

describe('contact identity (AC03, AC04)', () => {
  it('AC03: two parallel deliveries with the same phone → one contact, no duplicate lead', async () => {
    const ph = phone();
    await Promise.all([sendLeadAds(app, core, { fullName: 'Parallel 1', phone: ph, platform: 'ig' }), sendLeadAds(app, core, { fullName: 'Parallel 1', phone: ph, platform: 'ig' })]);
    // Process the two inbox rows concurrently to exercise the advisory locks.
    const ids = await core.processing.claimInboxBatch(50);
    await Promise.all(ids.map((id) => core.processing.processInbox(id)));
    await drain(core);
    expect(await p().contact.count({ where: { primaryPhone: ph } })).toBe(1);
    const c = await p().contact.findFirstOrThrow({ where: { primaryPhone: ph } });
    expect(await p().lead.count({ where: { contactId: c.id } })).toBe(1);
  });

  it('AC03: Instagram and phone pointing to different contacts → conflict review, no silent merge', async () => {
    const ph = phone();
    await sendLeadAds(app, core, { fullName: 'Telefon Egasi', phone: ph, platform: 'ig' });
    await drain(core);
    const phoneContact = await p().contact.findFirstOrThrow({ where: { primaryPhone: ph } });
    const sender = `99${Date.now()}`;
    await sendDirect(app, core, { sender, text: 'Salom' });
    await drain(core);
    const conv = await p().conversation.findFirstOrThrow({ where: { scopedPeerId: sender } });
    expect(conv.contactId).not.toBe(phoneContact.id);
    // A manager later links the phone to the IG contact: both contacts stay, candidate created.
    await p().$transaction(async (tx) => {
      const { identifyContact } = await import('../../apps/api/src/core/services/identity.service');
      const r = await identifyContact(tx, {
        companyId: conv.companyId,
        identifiers: [
          { type: 'instagram_scoped', value: sender, scope: conv.businessAccountId, verified: true },
          { type: 'phone', value: ph, scope: '', verified: true },
        ],
        fullName: null,
        primaryPhone: null,
        primaryEmail: null,
      });
      expect(r).toMatchObject({ decision: 'mapped', contactId: conv.contactId, reviewCount: 1 });
    });
    const cand = await p().duplicateCandidate.findFirstOrThrow({ where: { contactIds: { hasEvery: [phoneContact.id, conv.contactId] } } });
    expect(cand.reason).toBe('phone_points_to_other_contact');
    expect((await p().contact.findUniqueOrThrow({ where: { id: phoneContact.id } })).mergedIntoId).toBeNull();
  });

  it('AC04: a phone marked shared is never used to auto-link people', async () => {
    const ph = phone();
    await sendLeadAds(app, core, { fullName: 'Ota', phone: ph, platform: 'ig' });
    await drain(core);
    await p().contactIdentifier.updateMany({ where: { value: ph }, data: { shared: true } });
    await sendLeadAds(app, core, { fullName: 'Qizi', phone: ph, platform: 'ig' });
    await drain(core);
    const contacts = await p().contact.findMany({ where: { primaryPhone: ph } });
    expect(contacts).toHaveLength(2);
    expect(await p().duplicateCandidate.count({ where: { reason: 'shared_identifier', contactIds: { hasSome: contacts.map((c) => c.id) } } })).toBeGreaterThan(0);
  });
});

describe('Direct (AC05, AC06, AC07, AC08) and echo', () => {
  it('AC05: first message creates a lead, following messages stay in the same conversation', async () => {
    const sender = `98${Date.now()}`;
    for (const text of ['Salom', 'Dubay narxi?', 'Rahmat']) await sendDirect(app, core, { sender, text });
    await drain(core);
    const conv = await p().conversation.findFirstOrThrow({ where: { scopedPeerId: sender } });
    expect(await p().message.count({ where: { conversationId: conv.id, direction: 'inbound' } })).toBe(3);
    expect(await p().lead.count({ where: { contactId: conv.contactId } })).toBe(1);
    expect(await p().inquiry.count({ where: { contactId: conv.contactId } })).toBe(1);
    // Every inbound message was imported into the amoCRM chat once.
    const msgs = await p().message.findMany({ where: { conversationId: conv.id } });
    expect(msgs.every((m) => m.amoMessageId)).toBe(true);
  });

  it('duplicate message delivery (same mid) is stored once', async () => {
    const sender = `97${Date.now()}`;
    const { mid } = await sendDirect(app, core, { sender, text: 'bir' });
    await sendDirect(app, core, { sender, text: 'bir', mid });
    await drain(core);
    expect(await p().message.count({ where: { providerMessageId: mid } })).toBe(1);
  });

  it('AC08: click-to-Direct ad keeps direct channel + referral, never counted as a lead form', async () => {
    const sender = `96${Date.now()}`;
    await sendDirect(app, core, { sender, text: 'Reklamadan', referralAdId: '120000000000555' });
    await drain(core);
    const conv = await p().conversation.findFirstOrThrow({ where: { scopedPeerId: sender } });
    const inquiry = await p().inquiry.findFirstOrThrow({ where: { contactId: conv.contactId } });
    expect(inquiry.channel).toBe('instagram_direct');
    expect((inquiry.attribution as { referral: { adId: string } }).referral.adId).toBe('120000000000555');
    const lead = await p().lead.findUniqueOrThrow({ where: { id: conv.leadId! } });
    expect(lead.firstSource).toBe('instagram_direct');
  });

  it('AC06 (demo adapter): owner reply typed in amoCRM is sent via Send API, provider id and state stored', async () => {
    const sender = `95${Date.now()}`;
    await sendDirect(app, core, { sender, text: 'Savol' });
    await drain(core);
    const conv = await p().conversation.findFirstOrThrow({ where: { scopedPeerId: sender } });
    const lead = await p().lead.findUniqueOrThrow({ where: { id: conv.leadId! } });
    const owner = await p().user.findUniqueOrThrow({ where: { id: lead.ownerId! } });
    const r = await sendChatReply(app, core, { conversationId: conv.id, receiver: sender, text: 'Javob', authorAmoUserId: owner.amoUserId! });
    expect(r.status).toBe(200);
    await drain(core);
    const out = await p().message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'outbound' } });
    expect(out.state).toBe('accepted'); // never "delivered" without a delivery event
    expect(out.providerMessageId).toMatch(/^demo_mid_/);
    const sent = await (core.deps.adapters.metaDirect as DemoMetaDirectClient).sentMessages();
    expect(sent.some((s) => s.recipientScopedId === sender && s.text === 'Javob' && s.tag === null)).toBe(true);
    const updatedConv = await p().conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(updatedConv.firstHumanReplyAt).not.toBeNull();

    // Echo of our own message must not become a customer message.
    await sendDirect(app, core, { sender, text: 'Javob', mid: out.providerMessageId!, echo: true });
    await drain(core);
    expect(await p().message.count({ where: { conversationId: conv.id, direction: 'inbound' } })).toBe(1);
    expect(await p().message.count({ where: { conversationId: conv.id, direction: 'outbound' } })).toBe(1);
  });

  it('a manager who does not own the conversation cannot reply through amoCRM', async () => {
    const sender = `94${Date.now()}`;
    await sendDirect(app, core, { sender, text: 'Savol' });
    await drain(core);
    const conv = await p().conversation.findFirstOrThrow({ where: { scopedPeerId: sender } });
    const lead = await p().lead.findUniqueOrThrow({ where: { id: conv.leadId! } });
    const other = await p().user.findFirstOrThrow({ where: { role: 'MANAGER', id: { not: lead.ownerId! } } });
    await sendChatReply(app, core, { conversationId: conv.id, receiver: sender, text: 'Begona', authorAmoUserId: other.amoUserId! });
    await drain(core);
    const out = await p().message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'outbound' } });
    expect(out).toMatchObject({ state: 'failed', error: 'no_permission' });
  });

  it('AC07: closed messaging window blocks sending with a reason; internal reminders are unaffected', async () => {
    const sender = `93${Date.now()}`;
    await sendDirect(app, core, { sender, text: 'Eski savol', timestamp: Date.now() - 30 * 3600_000 });
    await drain(core);
    const conv = await p().conversation.findFirstOrThrow({ where: { scopedPeerId: sender } });
    const lead = await p().lead.findUniqueOrThrow({ where: { id: conv.leadId! } });
    const owner = await p().user.findUniqueOrThrow({ where: { id: lead.ownerId! } });
    const before = (await (core.deps.adapters.metaDirect as DemoMetaDirectClient).sentMessages()).length;
    await sendChatReply(app, core, { conversationId: conv.id, receiver: sender, text: 'Kech javob', authorAmoUserId: owner.amoUserId! });
    await drain(core);
    const out = await p().message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'outbound' } });
    expect(out).toMatchObject({ state: 'failed', error: 'window_closed' });
    expect((await (core.deps.adapters.metaDirect as DemoMetaDirectClient).sentMessages()).length).toBe(before);
    const notif = await p().notification.findFirst({ where: { userId: owner.id, kind: 'direct_blocked' }, orderBy: { createdAt: 'desc' } });
    expect(notif?.body).toContain('Javob oynasi yopilgan');
  });

  it('send timeout → unknown state, no blind retry; echo reconciles it', async () => {
    const sender = `92${Date.now()}`;
    await sendDirect(app, core, { sender, text: 'Savol' });
    await drain(core);
    const conv = await p().conversation.findFirstOrThrow({ where: { scopedPeerId: sender } });
    const lead = await p().lead.findUniqueOrThrow({ where: { id: conv.leadId! } });
    const owner = await p().user.findUniqueOrThrow({ where: { id: lead.ownerId! } });
    await core.deps.adapters.demoStore!.injectFailure('meta_direct', 'timeout_after_create');
    await sendChatReply(app, core, { conversationId: conv.id, receiver: sender, text: 'Noaniq javob', authorAmoUserId: owner.amoUserId! });
    await drain(core);
    const out = await p().message.findFirstOrThrow({ where: { conversationId: conv.id, direction: 'outbound' } });
    expect(out.state).toBe('unknown');
    const op = await p().outboxOperation.findFirstOrThrow({ where: { action: 'meta.send', payload: { path: ['messageId'], equals: out.id } } });
    expect(op.state).toBe('unknown');
    const sentCount = (await (core.deps.adapters.metaDirect as DemoMetaDirectClient).sentMessages()).filter((s) => s.text === 'Noaniq javob').length;
    expect(sentCount).toBe(1);
    await sendDirect(app, core, { sender, text: 'Noaniq javob', echo: true });
    await drain(core);
    expect((await p().message.findUniqueOrThrow({ where: { id: out.id } })).state).toBe('accepted');
  });
});

describe('durable ACK (AC26)', () => {
  it('when the database is unavailable the webhook does not return success', async () => {
    const broken = createCore(testConfig({ DATABASE_URL: 'postgresql://crm:crm_local_only@127.0.0.1:1/none?connect_timeout=2' }));
    const brokenApp = await createApp(broken);
    await brokenApp.init();
    const body = JSON.stringify({ object: 'page', entry: [{ id: '100000000000001', changes: [{ field: 'leadgen', value: { leadgen_id: 'db-down-1', page_id: '100000000000001' } }] }] });
    const r = await request(brokenApp.getHttpServer()).post('/webhooks/meta').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signMetaBody(body, broken.deps.config.meta.appSecret)).send(body);
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(r.body.error).toBeDefined();
    await brokenApp.close();
    await broken.close();
  });
});

describe('session sanity', () => {
  it('head can open the integrations health page', async () => {
    const head = await login(app, 'rahbar@demo.local');
    const r = await head.get('/api/v1/integrations/health');
    expect(r.status).toBe(200);
    expect(r.body.appMode).toBe('demo');
  });
});
