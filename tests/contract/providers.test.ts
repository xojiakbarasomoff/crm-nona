import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertAdaptersAllowed,
  classifyStatus,
  isAdReferral,
  MockAdapterInProductionError,
  normalizeLead,
  parseMetaWebhook,
  redactBody,
  signMetaBody,
  verifyChallenge,
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

  it('reads ad metadata from a message referral and a standalone referral; only ADS/ad_id counts as an ad', () => {
    const at = 1_790_000_000_000;
    const events = parseMetaWebhook({
      object: 'instagram',
      entry: [{ id: '17840000000000001', messaging: [
        { sender: { id: '990000000000007' }, recipient: { id: '17840000000000001' }, timestamp: at, message: { mid: 'm_ad', text: 'Narx?', referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: '120000000000801', ads_context_data: { ad_title: 'Dubai', photo_url: 'https://cdn/x.jpg', post_id: '180000000000009' } } } },
        { sender: { id: '990000000000008' }, recipient: { id: '17840000000000001' }, timestamp: at, referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: '120000000000802' } },
        { sender: { id: '990000000000009' }, recipient: { id: '17840000000000001' }, timestamp: at, referral: { source: 'SHORTLINK', type: 'OPEN_THREAD', ref: 'bio' } },
      ] }],
    });
    expect(events.map((e) => e.kind)).toEqual(['ig_message', 'ig_referral', 'ig_referral']);
    const [msg, standalone, shortlink] = events as [Extract<(typeof events)[number], { kind: 'ig_message' }>, Extract<(typeof events)[number], { kind: 'ig_referral' }>, Extract<(typeof events)[number], { kind: 'ig_referral' }>];
    expect(msg.referral).toEqual({ source: 'ADS', type: 'OPEN_THREAD', adId: '120000000000801', ref: null, adTitle: 'Dubai', postId: '180000000000009', productId: null });
    expect(standalone).toMatchObject({ businessAccountId: '17840000000000001', scopedPeerId: '990000000000008', key: `ig_referral:17840000000000001:990000000000008:${at}:120000000000802` });
    expect(isAdReferral(msg.referral)).toBe(true);
    expect(isAdReferral(standalone.referral)).toBe(true);
    expect(isAdReferral(shortlink.referral)).toBe(false);
    expect(isAdReferral(null)).toBe(false);
  });

  it('normalizes the lead object without guessing platform', () => {
    const lead = normalizeLead('140000000000031', JSON.parse(fx('meta/lead-object.json').toString()));
    expect(lead).toMatchObject({ formId: '130000000000021', campaignId: '160000000000051', platform: 'ig' });
    expect(lead.fields.phone_number).toBe('+998900000001');
    expect(normalizeLead('x', { field_data: [] }).platform).toBeNull();
  });
});

describe('adapter guards', () => {
  it('production refuses mock adapters', () => {
    expect(() => assertAdaptersAllowed('production', [{ name: 'meta-direct-demo', kind: 'mock' }])).toThrow(MockAdapterInProductionError);
    expect(() => assertAdaptersAllowed('staging', [{ name: 'x', kind: 'mock' }])).toThrow();
    expect(() => assertAdaptersAllowed('demo', [{ name: 'x', kind: 'mock' }])).not.toThrow();
  });
  it('classifies statuses and redacts tokens', () => {
    expect(classifyStatus(429, '')).toBe('rate_limited');
    expect(classifyStatus(503, '')).toBe('transient');
    expect(classifyStatus(403, 'account blocked: payment required')).toBe('billing');
    expect(redactBody('{"access_token":"abc.def","x":1}')).toBe('{"access_token":"[REDACTED]","x":1}');
  });
});
