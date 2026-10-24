import { DateTime } from 'luxon';

/**
 * Weekly working schedule in a given IANA zone. Days use ISO numbering 1=Mon..7=Sun.
 * Intervals are "HH:mm" local times; end is exclusive. Overnight intervals are not supported
 * (split them across two days instead).
 */
export interface WeeklySchedule {
  timezone: string;
  days: Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, Array<{ start: string; end: string }>>>;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function isWithinSchedule(schedule: WeeklySchedule | null | undefined, at: Date): boolean {
  if (!schedule) return true;
  const local = DateTime.fromJSDate(at, { zone: schedule.timezone });
  const intervals = schedule.days[local.weekday as 1] ?? [];
  const minute = local.hour * 60 + local.minute;
  return intervals.some((i) => minute >= minutesOf(i.start) && minute < minutesOf(i.end));
}

/**
 * Adds working minutes to a start instant. Time outside the schedule does not count (TZ §10 SLA).
 * Returns null when the schedule has no working time at all.
 */
export function addWorkingMinutes(schedule: WeeklySchedule, start: Date, minutes: number): Date | null {
  const hasAny = Object.values(schedule.days).some((d) => (d ?? []).length > 0);
  if (!hasAny) return null;
  let remaining = minutes;
  let cursor = DateTime.fromJSDate(start, { zone: schedule.timezone });
  for (let guard = 0; guard < 366 * 2; guard++) {
    const dayStart = cursor.startOf('day');
    const intervals = [...(schedule.days[cursor.weekday as 1] ?? [])].sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
    for (const i of intervals) {
      const iStart = dayStart.plus({ minutes: minutesOf(i.start) });
      const iEnd = dayStart.plus({ minutes: minutesOf(i.end) });
      if (iEnd <= cursor) continue;
      const from = iStart > cursor ? iStart : cursor;
      const available = iEnd.diff(from, 'minutes').minutes;
      if (remaining <= available) return from.plus({ minutes: remaining }).toJSDate();
      remaining -= available;
      cursor = iEnd;
    }
    cursor = dayStart.plus({ days: 1 });
  }
  return null;
}

/** Working minutes elapsed between two instants. */
export function workingMinutesBetween(schedule: WeeklySchedule, from: Date, to: Date): number {
  if (to <= from) return 0;
  let total = 0;
  let cursor = DateTime.fromJSDate(from, { zone: schedule.timezone });
  const end = DateTime.fromJSDate(to, { zone: schedule.timezone });
  while (cursor < end) {
    const dayStart = cursor.startOf('day');
    for (const i of schedule.days[cursor.weekday as 1] ?? []) {
      const iStart = dayStart.plus({ minutes: minutesOf(i.start) });
      const iEnd = dayStart.plus({ minutes: minutesOf(i.end) });
      const a = iStart > cursor ? iStart : cursor;
      const b = iEnd < end ? iEnd : end;
      if (b > a) total += b.diff(a, 'minutes').minutes;
    }
    cursor = dayStart.plus({ days: 1 });
  }
  return Math.round(total);
}
