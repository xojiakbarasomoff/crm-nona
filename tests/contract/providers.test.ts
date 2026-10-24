import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertAdaptersAllowed,
  assertAllowedDomain,
  classifyStatus,
  MockAdapterInProductionError,
  normalizeLead,
  parseAmoCrmWebhook,
  parseChatsWebhook,
  parseMetaWebhook,
  redactBody,
  signChatsRequest,
  signMetaBody,
  verifyChallenge,
  verifyChatsWebhook,
  verifyMetaSignature,
} from '@crm/integrations';

const fx = (p: string) => readFileSync(join(__dirname, '..', 'fixtures', p));

describe('Meta webhook signature (raw body, [S10])', () => {
  const raw = fx('meta/page-leadgen.json');
  it('accepts a valid signature over raw bytes', () => {
    expect(verifyMetaSignature(raw, signMetaBody(raw, 'secret'), 'secret')).toBe(true);
  });
  it('rejects a body that was re-serialized', () => {
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString())));
    expect(verifyMetaSignature(reserialized, signMetaBody(raw, 'secret'), 'secret')).toBe(false);
  });
  it('rejects wrong secret, missing header, wrong algorithm', () => {
    expect(verifyMetaSignature(raw, signMetaBody(raw, 'other'), 'secret')).toBe(false);
    expect(verifyMetaSignature(raw, undefined, 'secret')).toBe(false);
    expect(verifyMetaSignature(raw, 'sha1=abc', 'secret')).toBe(false);
  });
  it('GET verification is a separate token check', () => {
    expect(verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'v', 'hub.challenge': '42' }, 'v')).toEqual({ ok: true, challenge: '42' });
    expect(verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '42' }, 'v')).toEqual({ ok: false });
  });
});

describe('Meta webhook parsing', () => {
  it('splits leadgen deliveries into one event per lead', () => {
    const events = parseMetaWebhook(JSON.parse(fx('meta/page-leadgen.json').toString()));
    expect(events.map((e) => e.key)).toEqual(['leadgen:140000000000031', 'leadgen:140000000000032']);
    expect(events[1]).toMatchObject({ kind: 'leadgen', adId: null });
  });

  it('distinguishes messages, echoes, referrals, unsupported media and reads', () => {
    const events = parseMetaWebhook(JSON.parse(fx('meta/instagram-messaging.json').toString()));
    expect(events.map((e) => e.kind)).toEqual(['ig_message', 'ig_message', 'ig_message', 'ig_message', 'ig_read']);
    const [first, ad, echo, reel] = events as Array<Extract<(typeof events)[number], { kind: 'ig_message' }>>;
    expect(first).toMatchObject({ scopedPeerId: '990000000000001', businessAccountId: '17840000000000001', isEcho: false });
    expect(ad?.referral).toMatchObject({ source: 'ADS', adId: '120000000000099' });
    expect(echo).toMatchObject({ isEcho: true, scopedPeerId: '990000000000001', key: 'ig_echo:aWdfZAG1faXRlbTpEEMO3' });
    expect(reel?.isUnsupported).toBe(false);
    expect(reel?.attachments[0]?.type).toBe('ig_reel');
  });

  it('normalizes the lead object without guessing platform', () => {
    const lead = normalizeLead('140000000000031', JSON.parse(fx('meta/lead-object.json').toString()));
    expect(lead).toMatchObject({ formId: '130000000000021', campaignId: '160000000000051', platform: 'ig' });
    expect(lead.fields.phone_number).toBe('+998900000001');
    expect(normalizeLead('x', { field_data: [] }).platform).toBeNull();
  });
});

describe('amoCRM CRM webhook (form-urlencoded, [S11])', () => {
  it('parses nested keys into per-entity signals with versioned keys', () => {
    const signals = parseAmoCrmWebhook(fx('amocrm/crm-webhook-status.txt').toString().trim());
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({ entity: 'leads', action: 'status', id: '50000001', accountId: '30000001', key: 'leads:status:50000001:1761300200' });
    expect(signals[1]?.hint.responsible_user_id).toBe('9000002');
  });
});

describe('amoCRM Chats API signature (own scheme, [S03])', () => {
  it('signs requests and verifies webhooks with HMAC-SHA1, not the Meta scheme', () => {
    const h = signChatsRequest('s', 'POST', '/v2/origin/custom/abc', '{}', 'Fri, 24 Oct 2026 10:00:00 GMT');
    expect(h['Content-MD5']).toBe('99914b932bd37a50b983c5e7c90ae93b');
    expect(h['X-Signature']).toMatch(/^[0-9a-f]{40}$/);
    const body = Buffer.from('{"a":1}');
    const sig = require('node:crypto').createHmac('sha1', 's').update(body).digest('hex');
    expect(verifyChatsWebhook(body, sig, 's')).toBe(true);
    expect(verifyChatsWebhook(body, signMetaBody(body, 's'), 's')).toBe(false);
  });
  it('parses manager reply webhook', () => {
    const r = parseChatsWebhook({
      account_id: 'scope1',
      time: 1761300300,
      message: {
        receiver: { client_id: '990000000000001' },
        sender: { id: 'amo-user-1' },
        conversation: { client_id: 'conv-1' },
        timestamp: 1761300300,
        message: { id: 'amo-msg-1', type: 'text', text: 'Ha, bor' },
      },
    });
    expect(r).toMatchObject({ amoMessageId: 'amo-msg-1', conversationId: 'conv-1', receiverId: '990000000000001', text: 'Ha, bor' });
  });
});

describe('adapter guards', () => {
  it('production refuses mock adapters', () => {
    expect(() => assertAdaptersAllowed('production', [{ name: 'amocrm-demo', kind: 'mock' }])).toThrow(MockAdapterInProductionError);
    expect(() => assertAdaptersAllowed('staging', [{ name: 'x', kind: 'mock' }])).toThrow();
    expect(() => assertAdaptersAllowed('demo', [{ name: 'x', kind: 'mock' }])).not.toThrow();
  });
  it('amo domain allowlist rejects arbitrary URLs', () => {
    expect(assertAllowedDomain('https://acme.amocrm.ru/', ['acme.amocrm.ru'])).toBe('acme.amocrm.ru');
    expect(() => assertAllowedDomain('evil.example.com', ['acme.amocrm.ru'])).toThrow();
    expect(() => assertAllowedDomain('other.amocrm.ru', ['acme.amocrm.ru'])).toThrow();
  });
  it('classifies statuses and redacts tokens', () => {
    expect(classifyStatus(429, '')).toBe('rate_limited');
    expect(classifyStatus(503, '')).toBe('transient');
    expect(classifyStatus(403, 'account blocked: payment required')).toBe('billing');
    expect(redactBody('{"access_token":"abc.def","x":1}')).toBe('{"access_token":"[REDACTED]","x":1}');
  });
});
