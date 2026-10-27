import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signMetaBody } from '@crm/integrations';
import type { Core } from '../../apps/api/src/core';
import { alwaysOnDuty, DEMO_IG_BUSINESS_ID, drain, login, makeApp, makeCore, sendDirect, type Session } from './helpers';

let core: Core;
let app: INestApplication;
let admin: Session;

beforeAll(async () => {
  core = makeCore();
  await alwaysOnDuty(core);
  app = await makeApp(core);
  admin = await login(app, 'admin2@demo.local');
});
afterAll(async () => {
  await app.close();
  await core.close();
});

const p = () => core.deps.prisma;
const peer = (tag: string) => `97${tag}${Date.now()}`;
const AD_CONTEXT = { ad_title: 'Istanbul 4 kun', photo_url: 'https://scontent.example/x.jpg', post_id: '180000000000001' };

/** Xabarsiz alohida referral hodisasi (Meta `messaging[].referral`). */
async function sendReferral(sender: string, referral: Record<string, unknown>, ts = Date.now()) {
  const body = Buffer.from(JSON.stringify({ object: 'instagram', entry: [{ id: DEMO_IG_BUSINESS_ID, time: ts, messaging: [{ sender: { id: sender }, recipient: { id: DEMO_IG_BUSINESS_ID }, timestamp: ts, referral }] }] }));
  const send = () => request(app.getHttpServer()).post('/webhooks/meta').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signMetaBody(body, core.deps.config.meta.appSecret)).send(body.toString());
  return { res: await send(), resend: send };
}

/** Xabar ichida reklama metadata'si bilan. */
async function sendAdMessage(sender: string, adId: string, text = 'Narxi qancha?') {
  const ts = Date.now();
  const message = { mid: `mid_ad_${sender}_${ts}`, text, referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: adId, ads_context_data: AD_CONTEXT } };
  const body = Buffer.from(JSON.stringify({ object: 'instagram', entry: [{ id: DEMO_IG_BUSINESS_ID, time: ts, messaging: [{ sender: { id: sender }, recipient: { id: DEMO_IG_BUSINESS_ID }, timestamp: ts, message }] }] }));
  return request(app.getHttpServer()).post('/webhooks/meta').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signMetaBody(body, core.deps.config.meta.appSecret)).send(body.toString());
}

async function leadOf(sender: string) {
  const conv = await p().conversation.findFirstOrThrow({ where: { scopedPeerId: sender } });
  return p().lead.findUniqueOrThrow({ where: { id: conv.leadId! } });
}

describe('Instagram Direct: reklamadan kelgan mijoz («Таргет»)', () => {
  it('xabar ichidagi referral ADS: lid belgilanadi, manba Instagram Direct qoladi, metadata saqlanadi', async () => {
    const sender = peer('1');
    expect((await sendAdMessage(sender, '120000000000701')).status).toBe(200);
    await drain(core);
    const lead = await leadOf(sender);
    expect(lead.firstSource).toBe('instagram_direct');
    expect(lead.adReferralAt).not.toBeNull();
    expect(lead.adReferral).toMatchObject({ source: 'ADS', adId: '120000000000701', adTitle: 'Istanbul 4 kun', postId: '180000000000001' });
    // Vaqtinchalik media URL saqlanmaydi.
    expect(JSON.stringify(lead.adReferral)).not.toContain('scontent');
    const detail = await admin.get(`/api/v1/leads/${lead.id}`);
    expect(detail.body.lead.adReferral.adId).toBe('120000000000701');
  });

  it('reklama dalili yo‘q: belgi qo‘yilmaydi (taxmin qilinmaydi)', async () => {
    const plain = peer('2');
    await sendDirect(app, core, { sender: plain, text: 'Salom' });
    // ig.me havola kabi reklama bo'lmagan referral ham «Таргет» emas.
    const shortlink = peer('3');
    await sendReferral(shortlink, { source: 'SHORTLINK', type: 'OPEN_THREAD', ref: 'bio' });
    await sendDirect(app, core, { sender: shortlink, text: 'Salom' });
    await drain(core);
    expect((await leadOf(plain)).adReferralAt).toBeNull();
    expect((await leadOf(shortlink)).adReferralAt).toBeNull();
    expect(await p().igAdReferral.count({ where: { scopedPeerId: shortlink } })).toBe(0);
  });

  it('referral xabardan OLDIN alohida keladi: dublikat kontakt/lid yaratmaydi, birinchi xabar lidiga bog‘lanadi', async () => {
    const sender = peer('4');
    const { res, resend } = await sendReferral(sender, { source: 'ADS', type: 'OPEN_THREAD', ad_id: '120000000000702', ads_context_data: AD_CONTEXT });
    expect(res.status).toBe(200);
    await resend();
    await drain(core);
    expect(await p().conversation.count({ where: { scopedPeerId: sender } })).toBe(0);
    expect(await p().contactIdentifier.count({ where: { value: sender } })).toBe(0);
    expect(await p().igAdReferral.count({ where: { scopedPeerId: sender } })).toBe(1);

    await sendDirect(app, core, { sender, text: 'Assalomu alaykum' });
    await drain(core);
    const lead = await leadOf(sender);
    expect(lead.adReferral).toMatchObject({ adId: '120000000000702' });
    expect(await p().lead.count({ where: { contactId: lead.contactId } })).toBe(1);
    expect(await p().igAdReferral.findFirstOrThrow({ where: { scopedPeerId: sender } })).toMatchObject({ leadId: lead.id });
  });

  it('referral xabardan KEYIN keladi: mavjud lid belgilanadi, manba va tarix o‘zgarmaydi, takror hodisa ortiqcha yozuv yaratmaydi', async () => {
    const sender = peer('5');
    await sendDirect(app, core, { sender, text: 'Salom' });
    await drain(core);
    const before = await leadOf(sender);
    expect(before.adReferralAt).toBeNull();
    const { resend } = await sendReferral(sender, { source: 'ADS', type: 'OPEN_THREAD', ad_id: '120000000000703' });
    await resend();
    await drain(core);
    const after = await leadOf(sender);
    expect(after.id).toBe(before.id);
    expect(after).toMatchObject({ firstSource: before.firstSource, firstPlacement: before.firstPlacement, firstInquiryId: before.firstInquiryId, stage: before.stage, ownerId: before.ownerId });
    expect(after.adReferral).toMatchObject({ adId: '120000000000703' });
    expect(await p().igAdReferral.count({ where: { scopedPeerId: sender } })).toBe(1);
    expect(await p().lead.count({ where: { contactId: after.contactId } })).toBe(1);

    // Keyingi reklama birinchi dalilni almashtirmaydi.
    await sendAdMessage(sender, '120000000000799');
    await drain(core);
    expect((await leadOf(sender)).adReferral).toMatchObject({ adId: '120000000000703' });
  });

  it('filtr «Только из рекламы»: qidiruv bilan birga, ko‘rinish doirasida; dashboard jadvali ham', async () => {
    const ad = peer('6');
    const plain = peer('7');
    await sendAdMessage(ad, '120000000000704');
    await sendDirect(app, core, { sender: plain, text: 'Salom' });
    await drain(core);
    const adLead = await leadOf(ad);
    const plainLead = await leadOf(plain);

    const all = await admin.get('/api/v1/leads?limit=200&fromAd=true');
    expect(all.status).toBe(200);
    const ids = all.body.items.map((x: { id: string }) => x.id);
    expect(ids).toContain(adLead.id);
    expect(ids).not.toContain(plainLead.id);
    expect(all.body.items.every((x: { fromAd: boolean; firstSource: string }) => x.fromAd || x.firstSource !== 'instagram_direct')).toBe(true);
    expect(all.body.items.find((x: { id: string }) => x.id === adLead.id).fromAd).toBe(true);

    // Qidiruv bilan birga: reklamasiz lid nomi bo'yicha qidirilsa, filtr uni chiqarmaydi.
    const searched = await admin.get(`/api/v1/leads?limit=50&fromAd=true&search=${encodeURIComponent(plainLead.name)}`);
    expect(searched.body.items.map((x: { id: string }) => x.id)).not.toContain(plainLead.id);
    expect((await admin.get('/api/v1/leads?limit=50&fromAd=yes')).status).toBe(422);

    // Menejer faqat o'ziga ko'rinadigan lidlarni oladi.
    const mgr = await login(app, 'menejer.a@demo.local');
    const mgrId = (await p().user.findFirstOrThrow({ where: { email: 'menejer.a@demo.local' } })).id;
    const mine = await mgr.get('/api/v1/leads?limit=200&fromAd=true');
    expect(mine.body.items.every((x: { ownerId: string | null }) => x.ownerId === mgrId)).toBe(true);

    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
    const dash = await admin.get(`/api/v1/dashboard/leads?from=${day}&to=${day}&fromAd=true`);
    expect(dash.status).toBe(200);
    const dashIds = dash.body.items.map((x: { id: string }) => x.id);
    expect(dashIds).toContain(adLead.id);
    expect(dashIds).not.toContain(plainLead.id);
  });
});
