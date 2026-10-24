import { DateTime, IANAZone } from 'luxon';

/**
 * Local airport time ↔ UTC conversion with explicit DST handling (TZ §13.2, AC17).
 */

export const COMPANY_DEFAULT_TIMEZONE = 'Asia/Tashkent';

export function isValidIanaZone(zone: string): boolean {
  return IANAZone.isValidZone(zone) && !/^(UTC|GMT)?[+-]\d/.test(zone);
}

export type LocalToUtcResult =
  | { kind: 'ok'; utc: Date; offsetMinutes: number }
  | { kind: 'ambiguous'; options: Array<{ utc: Date; offsetMinutes: number }> }
  | { kind: 'nonexistent'; reason: 'dst_gap' }
  | { kind: 'invalid'; reason: 'bad_zone' | 'bad_format' };

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Converts a wall-clock local time ("2026-10-25T10:30") in an IANA zone to UTC.
 * If the local time occurs twice (DST fall-back) the caller must pick an offset; if it does not
 * exist (spring-forward gap) the input is rejected.
 * `confirmedOffsetMinutes` resolves an ambiguous time.
 */
export function localToUtc(local: string, zone: string, confirmedOffsetMinutes?: number | null): LocalToUtcResult {
  if (!isValidIanaZone(zone)) return { kind: 'invalid', reason: 'bad_zone' };
  const m = LOCAL_RE.exec(local);
  if (!m) return { kind: 'invalid', reason: 'bad_format' };
  const [, y, mo, d, h, mi, s] = m;
  const parts = { year: +y!, month: +mo!, day: +d!, hour: +h!, minute: +mi!, second: s ? +s : 0 };

  const candidates = new Map<number, DateTime>();
  const naiveUtc = DateTime.fromObject(parts, { zone: 'UTC' });
  if (!naiveUtc.isValid) return { kind: 'invalid', reason: 'bad_format' };
  // Probe offsets around the instant: any real offset in the zone within ±1 day.
  for (const probeHours of [-30, -18, -6, 0, 6, 18, 30]) {
    const probe = naiveUtc.plus({ hours: probeHours }).setZone(zone);
    const offset = probe.offset;
    const candidate = naiveUtc.minus({ minutes: offset });
    const back = candidate.setZone(zone);
    if (
      back.year === parts.year &&
      back.month === parts.month &&
      back.day === parts.day &&
      back.hour === parts.hour &&
      back.minute === parts.minute &&
      back.second === parts.second
    ) {
      candidates.set(back.offset, candidate);
    }
  }
  const options = [...candidates.entries()]
    .map(([offsetMinutes, dt]) => ({ utc: dt.toJSDate(), offsetMinutes }))
    .sort((a, b) => a.utc.getTime() - b.utc.getTime());

  if (options.length === 0) return { kind: 'nonexistent', reason: 'dst_gap' };
  if (options.length === 1) return { kind: 'ok', ...options[0]! };
  if (confirmedOffsetMinutes !== undefined && confirmedOffsetMinutes !== null) {
    const chosen = options.find((o) => o.offsetMinutes === confirmedOffsetMinutes);
    if (chosen) return { kind: 'ok', ...chosen };
  }
  return { kind: 'ambiguous', options };
}

export function utcToLocal(utc: Date, zone: string): { local: string; offsetMinutes: number } {
  const dt = DateTime.fromJSDate(utc, { zone });
  return { local: dt.toFormat("yyyy-MM-dd'T'HH:mm"), offsetMinutes: dt.offset };
}

const UZ_MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];

/** "25 oktabr 10:30" in the given zone. */
export function formatLocalUz(utc: Date, zone: string): string {
  const dt = DateTime.fromJSDate(utc, { zone });
  return `${dt.day} ${UZ_MONTHS[dt.month - 1]} ${dt.toFormat('HH:mm')}`;
}

/** "25 oktabr 10:30 — aeroport vaqti, Asia/Dubai (Toshkent: 25 oktabr 11:30)" */
export function formatAirportTimeUz(utc: Date, airportZone: string, companyZone = COMPANY_DEFAULT_TIMEZONE): string {
  const airport = `${formatLocalUz(utc, airportZone)} — aeroport vaqti, ${airportZone}`;
  if (airportZone === companyZone) return airport;
  return `${airport} (Toshkent: ${formatLocalUz(utc, companyZone)})`;
}

/**
 * Converts a company-local inclusive date range [fromDate, toDate] (YYYY-MM-DD) to a half-open
 * UTC interval [start, end) (TZ §15.2).
 */
export function companyDateRangeToUtc(fromDate: string, toDate: string, zone = COMPANY_DEFAULT_TIMEZONE): { start: Date; end: Date } {
  const start = DateTime.fromISO(fromDate, { zone }).startOf('day');
  const end = DateTime.fromISO(toDate, { zone }).startOf('day').plus({ days: 1 });
  if (!start.isValid || !end.isValid) throw new Error('Invalid date range');
  if (end <= start) throw new Error('Date range end must not be before start');
  return { start: start.toJSDate(), end: end.toJSDate() };
}

export type Bucket = 'day' | 'week' | 'month';

/** Company-zone bucket start (as YYYY-MM-DD) for charting. */
export function bucketKey(utc: Date, bucket: Bucket, zone = COMPANY_DEFAULT_TIMEZONE): string {
  const dt = DateTime.fromJSDate(utc, { zone });
  const start = bucket === 'day' ? dt.startOf('day') : bucket === 'week' ? dt.startOf('week') : dt.startOf('month');
  return start.toFormat('yyyy-MM-dd');
}

const localFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Fast "YYYY-MM-DDTHH:mm" wall-clock rendering for list views (cached Intl formatter per zone).
 * Equivalent to utcToLocal(...).local.
 */
export function formatLocalIso(utc: Date, zone: string): string {
  let f = localFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    localFormatters.set(zone, f);
  }
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(utc)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
