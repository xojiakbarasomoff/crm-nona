import { DateTime } from 'luxon';

/**
 * Flight milestone reminders, revision validity and manual recurrence (TZ §13.2, §14).
 */

export interface MilestoneRule {
  /** Stable code, e.g. "T-168h". */
  milestone: string;
  /** Seconds before departure. */
  offsetSeconds: number;
  enabled: boolean;
  /** Minutes after due until escalation to the head / duty user. */
  escalateAfterMinutes: number;
}

export const DEFAULT_MILESTONE_RULES: MilestoneRule[] = [
  { milestone: 'T-168h', offsetSeconds: 168 * 3600, enabled: true, escalateAfterMinutes: 60 },
  { milestone: 'T-72h', offsetSeconds: 72 * 3600, enabled: true, escalateAfterMinutes: 60 },
  { milestone: 'T-24h', offsetSeconds: 24 * 3600, enabled: true, escalateAfterMinutes: 60 },
  { milestone: 'T-3h', offsetSeconds: 3 * 3600, enabled: true, escalateAfterMinutes: 15 },
];

export const URGENT_MILESTONE = 'URGENT';
export const URGENT_ESCALATE_AFTER_MINUTES = 15;

export interface PlannedOccurrence {
  milestone: string;
  dueAt: Date;
  escalateAfterMinutes: number;
}

/**
 * Plans occurrences for one segment revision. Milestones already in the past are not sent
 * retroactively; if any were skipped while departure is still ahead, a single URGENT occurrence is
 * created instead (AC19). Calculation uses absolute UTC offsets (168h, 72h — not calendar days).
 */
export function planMilestones(departureAtUtc: Date, now: Date, rules: MilestoneRule[]): PlannedOccurrence[] {
  if (departureAtUtc.getTime() <= now.getTime()) return [];
  const enabled = rules.filter((r) => r.enabled).sort((a, b) => b.offsetSeconds - a.offsetSeconds);
  const planned: PlannedOccurrence[] = [];
  let skipped = false;
  for (const r of enabled) {
    const dueAt = new Date(departureAtUtc.getTime() - r.offsetSeconds * 1000);
    if (dueAt.getTime() <= now.getTime()) skipped = true;
    else planned.push({ milestone: r.milestone, dueAt, escalateAfterMinutes: r.escalateAfterMinutes });
  }
  if (skipped) planned.unshift({ milestone: URGENT_MILESTONE, dueAt: now, escalateAfterMinutes: URGENT_ESCALATE_AFTER_MINUTES });
  return planned;
}

export interface OccurrenceSnapshot {
  state: string;
  scheduleRevision: number | null;
  segmentId: string | null;
  kind: 'milestone' | 'manual';
}
export interface SegmentSnapshot {
  scheduleRevision: number;
  operationalStatus: string;
  active: boolean;
  departureAtUtc: Date | null;
}
export interface OrderSnapshot {
  fulfillmentState: string;
}

export type Validity = { valid: true } | { valid: false; reason: 'cancelled' | 'stale_revision' | 'segment_inactive' | 'order_cancelled' | 'segment_cancelled' | 'departed' | 'not_pending' };

/** Re-checked by the worker immediately before any side effect (TZ §14.4, AC21). */
export function checkOccurrenceValidity(occ: OccurrenceSnapshot, segment: SegmentSnapshot | null, order: OrderSnapshot | null, now: Date): Validity {
  if (occ.state === 'cancelled' || occ.state === 'superseded') return { valid: false, reason: 'cancelled' };
  if (!['scheduled', 'dispatching', 'snoozed'].includes(occ.state)) return { valid: false, reason: 'not_pending' };
  if (order && order.fulfillmentState === 'cancelled') return { valid: false, reason: 'order_cancelled' };
  if (occ.kind === 'milestone') {
    if (!segment) return { valid: false, reason: 'segment_inactive' };
    if (!segment.active) return { valid: false, reason: 'segment_inactive' };
    if (segment.operationalStatus === 'cancelled') return { valid: false, reason: 'segment_cancelled' };
    if (occ.scheduleRevision !== segment.scheduleRevision) return { valid: false, reason: 'stale_revision' };
    if (segment.departureAtUtc && segment.departureAtUtc.getTime() <= now.getTime()) return { valid: false, reason: 'departed' };
  }
  return { valid: true };
}

export function milestoneDedupeKey(companyId: string, segmentId: string, revision: number, ruleVersion: number, milestone: string): string {
  return `${companyId}:${segmentId}:${revision}:${ruleVersion}:${milestone}`;
}

/** Fields whose change bumps schedule_revision (TZ §13.4). */
export const REVISION_FIELDS = [
  'departureAtUtc',
  'arrivalAtUtc',
  'flightNumber',
  'marketingCarrier',
  'originIata',
  'destinationIata',
] as const;

export function revisionChanged(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return REVISION_FIELDS.some((f) => {
    if (!(f in after)) return false;
    const a = before[f];
    const b = after[f];
    if (a instanceof Date || b instanceof Date) return (a as Date | null)?.getTime?.() !== (b as Date | null)?.getTime?.();
    return a !== b;
  });
}

// ---------- Manual reminders ----------

export type Recurrence =
  | { kind: 'once' }
  | { kind: 'daily' | 'weekly'; until?: string | null; maxCount?: number | null };

export class RecurrenceValidationError extends Error {}

export function validateRecurrence(r: Recurrence): void {
  if (r.kind === 'once') return;
  if (!r.until && !r.maxCount) throw new RecurrenceValidationError('Recurring reminder requires an end date or maximum count');
  if (r.maxCount !== undefined && r.maxCount !== null && (r.maxCount < 1 || r.maxCount > 366)) {
    throw new RecurrenceValidationError('maxCount must be between 1 and 366');
  }
}

/**
 * Returns the due time of the n-th (0-based) occurrence, computed in the reminder's local zone so
 * that "every day at 09:00 Asia/Dubai" stays 09:00 local across DST. Returns null when the series
 * is exhausted.
 */
export function nthOccurrence(startLocal: string, zone: string, r: Recurrence, n: number): Date | null {
  const start = DateTime.fromISO(startLocal, { zone });
  if (!start.isValid) throw new RecurrenceValidationError('Invalid start time');
  if (r.kind === 'once') return n === 0 ? start.toJSDate() : null;
  if (r.maxCount && n >= r.maxCount) return null;
  const dt = r.kind === 'daily' ? start.plus({ days: n }) : start.plus({ weeks: n });
  if (r.until) {
    const until = DateTime.fromISO(r.until, { zone }).endOf('day');
    if (dt > until) return null;
  }
  return dt.toJSDate();
}

/** Snooze moves only the next due time; history is kept by the caller (audit). */
export function snoozeUntil(now: Date, minutes: number): Date {
  if (minutes < 1 || minutes > 7 * 24 * 60) throw new RecurrenceValidationError('Snooze must be between 1 minute and 7 days');
  return new Date(now.getTime() + minutes * 60_000);
}
