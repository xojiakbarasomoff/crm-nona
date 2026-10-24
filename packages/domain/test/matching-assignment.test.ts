import { describe, expect, it } from 'vitest';
import { decideAssignment, decideContactMatch, equalRoundRobin, type KnownIdentifier, type PoolMember } from '../src';

const ig = (value: string) => ({ type: 'instagram_scoped' as const, value, scope: 'biz1' });
const phone = (value: string) => ({ type: 'phone' as const, value, scope: '' });
const known = (contactId: string, i: { type: KnownIdentifier['type']; value: string; scope: string }, extra: Partial<KnownIdentifier> = {}): KnownIdentifier => ({
  ...i,
  contactId,
  verified: true,
  shared: false,
  ...extra,
});

describe('contact matching (TZ §7.2)', () => {
  it('existing provider mapping wins', () => {
    const d = decideContactMatch([ig('s1')], [known('c1', ig('s1'))]);
    expect(d).toEqual({ kind: 'mapped', contactId: 'c1', review: [] });
  });

  it('links to exactly one non-conflicting phone candidate', () => {
    const d = decideContactMatch([ig('s2'), phone('+998901112233')], [known('c1', phone('+998901112233'))]);
    expect(d.kind).toBe('linked');
  });

  it('phone and Instagram pointing to different contacts → no merge, review (AC03)', () => {
    const d = decideContactMatch([ig('s1'), phone('+998901112233')], [known('c1', ig('s1')), known('c2', phone('+998901112233'))]);
    expect(d.kind).toBe('mapped');
    if (d.kind === 'mapped') expect(d.contactId).toBe('c1');
    expect(d.review[0]?.reason).toBe('phone_points_to_other_contact');
  });

  it('shared family phone is never auto-linked (AC04)', () => {
    const d = decideContactMatch([phone('+998901112233')], [known('c1', phone('+998901112233'), { shared: true })]);
    expect(d.kind).toBe('create');
    expect(d.review[0]?.reason).toBe('shared_identifier');
  });

  it('phone owned by two contacts → review instead of picking one', () => {
    const d = decideContactMatch([phone('+998901112233')], [known('c1', phone('+998901112233')), known('c2', phone('+998901112233'))]);
    expect(d.kind).toBe('create');
  });

  it('candidate with a different Instagram ID in same scope → conflict, not link', () => {
    const d = decideContactMatch([ig('s9'), phone('+998901112233')], [known('c1', phone('+998901112233')), known('c1', ig('s1'))]);
    expect(d.kind).toBe('create');
    expect(d.review).toHaveLength(1);
  });

  it('unverified identifiers are not used for linking', () => {
    const d = decideContactMatch([phone('+998901112233')], [known('c1', phone('+998901112233'), { verified: false })]);
    expect(d.kind).toBe('create');
  });
});

const member = (userId: string, position: number, extra: Partial<PoolMember> = {}): PoolMember => ({
  userId,
  position,
  active: true,
  available: true,
  schedule: null,
  serviceTypes: null,
  ...extra,
});

describe('round-robin (TZ §10)', () => {
  const at = new Date('2026-10-26T06:00:00Z');

  it('distributes 100 leads among 3 equal managers with max diff 1 (AC10 rule)', () => {
    const members = [member('a', 0), member('b', 1), member('c', 2)];
    let pointer = -1;
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 100; i++) {
      const pick = equalRoundRobin.pick(members, pointer, { at, serviceType: null })!;
      counts[pick.userId]!++;
      pointer = pick.nextPointer;
    }
    const values = Object.values(counts);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
  });

  it('skips inactive, unavailable, off-schedule and wrong service type', () => {
    const offSchedule = { timezone: 'Asia/Tashkent', days: { 1: [{ start: '20:00', end: '21:00' }] } };
    const members = [
      member('a', 0, { active: false }),
      member('b', 1, { available: false }),
      member('c', 2, { schedule: offSchedule }),
      member('d', 3, { serviceTypes: ['visa'] }),
      member('e', 4),
    ];
    expect(equalRoundRobin.pick(members, -1, { at, serviceType: 'avia' })?.userId).toBe('e');
  });

  it('returns null when nobody is eligible', () => {
    expect(equalRoundRobin.pick([member('a', 0, { active: false })], -1, { at, serviceType: null })).toBeNull();
  });

  it('priority: existing lead > sticky owner > round robin > duty > queue (AC11)', () => {
    const base = { existingActiveLeadOwnerId: null, contactOwner: null, stickyOwnerEnabled: false, roundRobinPick: null, dutyUserId: null };
    expect(decideAssignment({ ...base, existingActiveLeadOwnerId: 'x' }).reason).toBe('existing_active_lead');
    expect(decideAssignment({ ...base, stickyOwnerEnabled: true, contactOwner: { userId: 'o', eligible: true } }).reason).toBe('sticky_owner');
    expect(decideAssignment({ ...base, stickyOwnerEnabled: true, contactOwner: { userId: 'o', eligible: false }, roundRobinPick: { userId: 'r', nextPointer: 1 } }).reason).toBe('round_robin');
    expect(decideAssignment({ ...base, dutyUserId: 'd' })).toMatchObject({ reason: 'duty_fallback', alertHead: true });
    expect(decideAssignment(base)).toMatchObject({ reason: 'awaiting_assignment', userId: null, alertHead: true });
  });
});
