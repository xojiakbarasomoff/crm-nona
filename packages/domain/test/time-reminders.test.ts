import { describe, expect, it } from 'vitest';
import {
  addWorkingMinutes,
  checkOccurrenceValidity,
  companyDateRangeToUtc,
  DEFAULT_MILESTONE_RULES,
  formatAirportTimeUz,
  localToUtc,
  nthOccurrence,
  planMilestones,
  revisionChanged,
  validateRecurrence,
  workingMinutesBetween,
} from '../src';

describe('timezone (AC17)', () => {
  it('converts airport local time to UTC via IANA zone', () => {
    const r = localToUtc('2026-10-25T10:30', 'Asia/Dubai');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.utc.toISOString()).toBe('2026-10-25T06:30:00.000Z');
    expect(formatAirportTimeUz(new Date('2026-10-25T06:30:00Z'), 'Asia/Dubai')).toBe(
      '25 oktabr 10:30 — aeroport vaqti, Asia/Dubai (Toshkent: 25 oktabr 11:30)',
    );
  });

  it('detects ambiguous fall-back time and requires an offset', () => {
    // Europe/Berlin falls back on 2026-10-25 at 03:00 → 02:30 happens twice.
    const r = localToUtc('2026-10-25T02:30', 'Europe/Berlin');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.options.map((o) => o.offsetMinutes)).toEqual([120, 60]);
    const confirmed = localToUtc('2026-10-25T02:30', 'Europe/Berlin', 60);
    expect(confirmed.kind === 'ok' && confirmed.utc.toISOString()).toBe('2026-10-25T01:30:00.000Z');
  });

  it('rejects non-existent spring-forward time', () => {
    expect(localToUtc('2026-03-29T02:30', 'Europe/Berlin').kind).toBe('nonexistent');
  });

  it('rejects fixed offsets instead of IANA zones', () => {
    expect(localToUtc('2026-10-25T10:30', 'UTC+4').kind).toBe('invalid');
  });

  it('company date range is [start, end) in UTC', () => {
    const { start, end } = companyDateRangeToUtc('2026-10-01', '2026-10-31');
    expect(start.toISOString()).toBe('2026-09-30T19:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-31T19:00:00.000Z');
  });
});

describe('working-hours SLA', () => {
  const schedule = { timezone: 'Asia/Tashkent', days: { 1: [{ start: '09:00', end: '18:00' }], 2: [{ start: '09:00', end: '18:00' }] } };
  it('starts counting at next working time', () => {
    // Monday 2026-10-26 20:00 Tashkent → deadline Tuesday 09:15
    const due = addWorkingMinutes(schedule, new Date('2026-10-26T15:00:00Z'), 15);
    expect(due?.toISOString()).toBe('2026-10-27T04:15:00.000Z');
    expect(workingMinutesBetween(schedule, new Date('2026-10-26T12:50:00Z'), new Date('2026-10-27T04:10:00Z'))).toBe(20);
  });
});

describe('milestones (AC18, AC19)', () => {
  const dep = new Date('2026-11-10T08:20:00Z');
  it('plans 168h/72h/24h/3h on absolute offsets', () => {
    const p = planMilestones(dep, new Date('2026-10-24T00:00:00Z'), DEFAULT_MILESTONE_RULES);
    expect(p.map((o) => [o.milestone, o.dueAt.toISOString()])).toEqual([
      ['T-168h', '2026-11-03T08:20:00.000Z'],
      ['T-72h', '2026-11-07T08:20:00.000Z'],
      ['T-24h', '2026-11-09T08:20:00.000Z'],
      ['T-3h', '2026-11-10T05:20:00.000Z'],
    ]);
  });

  it('order entered 2h before departure → exactly one URGENT occurrence', () => {
    const now = new Date(dep.getTime() - 2 * 3600_000);
    const p = planMilestones(dep, now, DEFAULT_MILESTONE_RULES);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ milestone: 'URGENT', dueAt: now });
  });

  it('partially passed → urgent + remaining future milestones', () => {
    const p = planMilestones(dep, new Date(dep.getTime() - 30 * 3600_000), DEFAULT_MILESTONE_RULES);
    expect(p.map((o) => o.milestone)).toEqual(['URGENT', 'T-24h', 'T-3h']);
  });

  it('nothing for departed flights; disabled rules are skipped', () => {
    expect(planMilestones(dep, new Date(dep.getTime() + 1), DEFAULT_MILESTONE_RULES)).toEqual([]);
    const rules = DEFAULT_MILESTONE_RULES.map((r) => ({ ...r, enabled: r.milestone !== 'T-72h' }));
    expect(planMilestones(dep, new Date('2026-10-01T00:00:00Z'), rules).map((o) => o.milestone)).toEqual(['T-168h', 'T-24h', 'T-3h']);
  });
});

describe('occurrence validity (AC21, AC22)', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const seg = { scheduleRevision: 2, operationalStatus: 'scheduled', active: true, departureAtUtc: new Date('2026-11-10T00:00:00Z') };
  const occ = { state: 'dispatching', scheduleRevision: 2, segmentId: 's', kind: 'milestone' as const };
  it('valid when revision matches', () => {
    expect(checkOccurrenceValidity(occ, seg, { fulfillmentState: 'confirmed' }, now)).toEqual({ valid: true });
  });
  it('stale revision is dropped', () => {
    expect(checkOccurrenceValidity({ ...occ, scheduleRevision: 1 }, seg, null, now)).toEqual({ valid: false, reason: 'stale_revision' });
  });
  it('cancelled order / segment stop reminders', () => {
    expect(checkOccurrenceValidity(occ, seg, { fulfillmentState: 'cancelled' }, now)).toMatchObject({ reason: 'order_cancelled' });
    expect(checkOccurrenceValidity(occ, { ...seg, operationalStatus: 'cancelled' }, null, now)).toMatchObject({ reason: 'segment_cancelled' });
  });
  it('revision changes on schedule fields only', () => {
    const d = new Date('2026-11-10T00:00:00Z');
    expect(revisionChanged({ departureAtUtc: d, pnr: 'A' }, { departureAtUtc: new Date(d), pnr: 'B' })).toBe(false);
    expect(revisionChanged({ departureAtUtc: d }, { departureAtUtc: new Date(d.getTime() + 60_000) })).toBe(true);
    expect(revisionChanged({ flightNumber: '371' }, { flightNumber: '373' })).toBe(true);
  });
});

describe('manual recurrence (AC24)', () => {
  it('recurring requires an end', () => {
    expect(() => validateRecurrence({ kind: 'daily' })).toThrow();
    expect(() => validateRecurrence({ kind: 'weekly', maxCount: 3 })).not.toThrow();
  });
  it('daily keeps local wall-clock across DST', () => {
    const r = { kind: 'daily' as const, maxCount: 3 };
    const times = [0, 1, 2, 3].map((n) => nthOccurrence('2026-10-24T09:00', 'Europe/Berlin', r, n)?.toISOString() ?? null);
    expect(times).toEqual(['2026-10-24T07:00:00.000Z', '2026-10-25T08:00:00.000Z', '2026-10-26T08:00:00.000Z', null]);
  });
  it('until bound is inclusive of the end date', () => {
    const r = { kind: 'weekly' as const, until: '2026-11-07' };
    expect(nthOccurrence('2026-10-24T09:00', 'Asia/Tashkent', r, 2)).not.toBeNull();
    expect(nthOccurrence('2026-10-24T09:00', 'Asia/Tashkent', r, 3)).toBeNull();
  });
});
