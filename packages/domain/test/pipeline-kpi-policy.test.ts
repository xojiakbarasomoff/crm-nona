import { describe, expect, it } from 'vitest';
import {
  awaitingReply,
  canonicalEventKey,
  checkTransition,
  closedConversion,
  cohortConversion,
  decideOutbound,
  decideRetry,
  deriveFirstResponse,
  detectAnomaly,
  firstResponseStats,
  maskReference,
  ownerScope,
  percent,
  resumeFromFollowUp,
  shouldApplyRemote,
  wonInPeriod,
  type LeadFacts,
} from '../src';

const facts = (over: Partial<LeadFacts> = {}): LeadFacts => ({
  stage: 'NEW',
  hasContactOrIdentifier: true,
  hasSource: true,
  ownerId: 'u1',
  contactOutcomeRecorded: false,
  requirements: { serviceType: null, destination: null, dateFrom: null, passengersTotal: null, budgetState: null },
  offerPrepDueAt: null,
  sentOfferVersionId: null,
  payment: { amountMinor: null, currency: null, dueAt: null, acceptedOfferId: null },
  order: { exists: false, agreedAmountSet: false, saleEvidence: false },
  lostReasonCode: null,
  followUp: { nextContactAt: null, note: null },
  ...over,
});

describe('pipeline transitions (TZ §11)', () => {
  it('requires stage fields server-side', () => {
    const r = checkTransition('NEW', 'CONTACTED', facts(), null);
    expect(r).toEqual({ ok: false, code: 'MISSING_FIELDS', missing: ['contact_outcome'] });
    expect(checkTransition('NEW', 'CONTACTED', facts({ contactOutcomeRecorded: true }), null)).toEqual({ ok: true, returnStage: null });
  });
  it('FOLLOW_UP stores return stage; resume goes back', () => {
    const r = checkTransition('OFFER_SENT', 'FOLLOW_UP', facts({ followUp: { nextContactAt: '2026-11-01T10:00:00Z', note: 'x' } }), null);
    expect(r).toEqual({ ok: true, returnStage: 'OFFER_SENT' });
    expect(resumeFromFollowUp('OFFER_SENT')).toBe('OFFER_SENT');
    expect(resumeFromFollowUp(null)).toBe('CONTACTED');
  });
  it('closed leads need explicit reopen', () => {
    expect(checkTransition('WON', 'NEW', facts(), null)).toMatchObject({ ok: false, code: 'CLOSED_REQUIRES_REOPEN' });
  });
  it('WON without order is an anomaly (AC14)', () => {
    expect(detectAnomaly('WON', facts())).toEqual(['order', 'order.agreed_amount', 'order.sale_evidence']);
  });
});

const d = (s: string) => new Date(s);
describe('KPI (AC32)', () => {
  const start = d('2026-10-01T00:00:00Z');
  const end = d('2026-11-01T00:00:00Z');
  const leads = [
    // created in Sept, won in Oct → not in Oct cohort, counts in closed conversion
    { id: 'old', createdAt: d('2026-09-10T00:00:00Z'), stage: 'WON', firstWonAt: d('2026-10-05T00:00:00Z'), closes: [{ stage: 'WON' as const, at: d('2026-10-05T00:00:00Z') }] },
    { id: 'n1', createdAt: d('2026-10-02T00:00:00Z'), stage: 'WON', firstWonAt: d('2026-10-20T00:00:00Z'), closes: [{ stage: 'WON' as const, at: d('2026-10-20T00:00:00Z') }] },
    { id: 'n2', createdAt: d('2026-10-03T00:00:00Z'), stage: 'LOST', firstWonAt: null, closes: [{ stage: 'LOST' as const, at: d('2026-10-04T00:00:00Z') }] },
    { id: 'n3', createdAt: d('2026-10-04T00:00:00Z'), stage: 'NEW', firstWonAt: null, closes: [] },
    // re-closed twice: counted once
    {
      id: 'n4',
      createdAt: d('2026-10-05T00:00:00Z'),
      stage: 'WON',
      firstWonAt: d('2026-10-06T00:00:00Z'),
      closes: [
        { stage: 'WON' as const, at: d('2026-10-06T00:00:00Z') },
        { stage: 'WON' as const, at: d('2026-10-09T00:00:00Z') },
      ],
    },
  ];
  it('cohort vs closed conversion differ by definition', () => {
    expect(cohortConversion(leads, start, end)).toMatchObject({ numerator: 2, denominator: 4, value: 50 });
    expect(closedConversion(leads, start, end)).toMatchObject({ numerator: 3, denominator: 4, value: 75 });
    expect(wonInPeriod(leads, start, end)).toBe(3);
  });
  it('zero denominator renders —', () => {
    expect(percent(0, 0)).toEqual({ value: null, display: '—' });
  });
});

describe('first response (AC33)', () => {
  it('ignores bot replies and internal notes', () => {
    const t = deriveFirstResponse([
      { direction: 'inbound', actorType: 'customer', isInternalNote: false, at: d('2026-10-01T10:00:00Z') },
      { direction: 'outbound', actorType: 'bot', isInternalNote: false, at: d('2026-10-01T10:00:05Z') },
      { direction: 'outbound', actorType: 'human', isInternalNote: true, at: d('2026-10-01T10:01:00Z') },
      { direction: 'outbound', actorType: 'human', isInternalNote: false, at: d('2026-10-01T10:07:00Z') },
    ]);
    expect(t?.firstHumanReplyAt?.toISOString()).toBe('2026-10-01T10:07:00.000Z');
  });
  it('median and p90', () => {
    const base = d('2026-10-01T10:00:00Z').getTime();
    const items = [60, 120, 180, 240, 600].map((s) => ({ firstInboundAt: new Date(base), firstHumanReplyAt: new Date(base + s * 1000) }));
    items.push({ firstInboundAt: new Date(base), firstHumanReplyAt: null as unknown as Date });
    const stats = firstResponseStats(items);
    expect(stats).toMatchObject({ observed: 6, answered: 5, unanswered: 1, medianSeconds: 180 });
    expect(stats.p90Seconds).toBeCloseTo(456);
  });
  it('awaiting reply after the last customer message', () => {
    expect(
      awaitingReply([
        { direction: 'outbound', actorType: 'human', isInternalNote: false, at: d('2026-10-01T10:00:00Z') },
        { direction: 'inbound', actorType: 'customer', isInternalNote: false, at: d('2026-10-01T11:00:00Z') },
      ]),
    ).toBe(true);
  });
});

describe('messaging policy (AC07)', () => {
  const cfg = { standardWindowHours: 24, humanAgentWindowHours: 168, humanAgentPermissionGranted: false };
  const base = {
    now: d('2026-10-02T12:00:00Z'),
    lastCustomerMessageAt: d('2026-10-02T00:00:00Z'),
    purpose: 'human_reply' as const,
    connectionHealthy: true,
    senderMayReply: true,
    recipientScopedIdVerified: true,
  };
  it('allows inside window, blocks outside with reason', () => {
    expect(decideOutbound(base, cfg)).toEqual({ allowed: true, tag: null });
    const r = decideOutbound({ ...base, now: d('2026-10-04T00:00:00Z') }, cfg);
    expect(r).toMatchObject({ allowed: false, reason: 'window_closed' });
  });
  it('Human Agent only with permission and only for human replies', () => {
    const late = { ...base, now: d('2026-10-04T00:00:00Z') };
    expect(decideOutbound(late, { ...cfg, humanAgentPermissionGranted: true })).toEqual({ allowed: true, tag: 'HUMAN_AGENT' });
    expect(decideOutbound({ ...late, purpose: 'automated_reminder' }, { ...cfg, humanAgentPermissionGranted: true })).toMatchObject({ allowed: false, reason: 'automated_not_allowed' });
  });
});

describe('sync and retry helpers', () => {
  it('old events do not roll back state (AC30)', () => {
    const local = { sourceUpdatedAt: d('2026-10-02T00:00:00Z'), stateHash: 'h2' };
    expect(shouldApplyRemote(local, { sourceUpdatedAt: d('2026-10-01T00:00:00Z'), stateHash: 'h1' })).toBe(false);
    expect(shouldApplyRemote(local, { sourceUpdatedAt: d('2026-10-03T00:00:00Z'), stateHash: 'h3' })).toBe(true);
    expect(shouldApplyRemote(local, { sourceUpdatedAt: d('2026-10-02T00:00:00Z'), stateHash: 'h2' })).toBe(false);
  });
  it('canonical event key separates distinct messages with equal timestamps', () => {
    const a = canonicalEventKey('meta', { mid: null, sender: '1', text: 'salom', ts: 1 });
    const b = canonicalEventKey('meta', { mid: null, sender: '1', text: 'salom!', ts: 1 });
    expect(a).not.toBe(b);
    expect(canonicalEventKey('meta', { ts: 1, text: 'salom', sender: '1', mid: null })).toBe(a);
  });
  it('retry table', () => {
    expect(decideRetry('validation', 1).action).toBe('dead_letter');
    expect(decideRetry('unauthorized', 1).action).toBe('refresh_token');
    expect(decideRetry('unauthorized', 2).action).toBe('pause_connection');
    expect(decideRetry('rate_limited', 1, { retryAfterMs: 7000 })).toEqual({ action: 'retry', delayMs: 7000 });
    expect(decideRetry('transient', 8).action).toBe('dead_letter');
    expect(decideRetry('unknown_outcome', 1).action).toBe('unknown');
  });
  it('masking and scope', () => {
    expect(maskReference('ABC123')).toBe('***123');
    expect(ownerScope({ id: 'm', role: 'MANAGER' })).toBe('m');
    expect(ownerScope({ id: 'h', role: 'ADMIN' })).toBeNull();
    expect(ownerScope({ id: 'u', role: 'USER' })).toBe('u');
  });
});
