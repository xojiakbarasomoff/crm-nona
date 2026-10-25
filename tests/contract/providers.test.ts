import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertAdaptersAllowed,
  classifyStatus,
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
