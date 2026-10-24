import { createHash } from 'node:crypto';

/** "TR-2026-000123" (TZ §12.3). */
export function formatOrderNo(prefix: string, year: number, seq: number | bigint): string {
  return `${prefix}-${year}-${seq.toString().padStart(6, '0')}`;
}

/** Masks PNR / ticket numbers for list views (TZ §13.1). */
export function maskReference(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (ref.length <= 3) return '*'.repeat(ref.length);
  return `${'*'.repeat(ref.length - 3)}${ref.slice(-3)}`;
}

/** Stable JSON (sorted keys) for hashing payloads. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Hash of the meaningful field values; used to stop write-back loops (TZ §5.2). */
export function stateHash(fields: Record<string, unknown>): string {
  return sha256Hex(stableStringify(fields));
}

/**
 * Dedupe key for provider events without an event ID (TZ §19.2). It is derived from canonical
 * identifiers and content — never from a time bucket, so distinct messages are never swallowed.
 */
export function canonicalEventKey(provider: string, parts: Record<string, string | number | null | undefined>): string {
  return `${provider}:${sha256Hex(stableStringify(parts))}`;
}

/**
 * Monotonic guard for out-of-order events (AC30): a remote snapshot is applied only if it is newer
 * than what we have. Equal timestamps apply only if the state hash differs.
 */
export function shouldApplyRemote(
  local: { sourceUpdatedAt: Date | null; stateHash: string | null },
  remote: { sourceUpdatedAt: Date; stateHash: string },
): boolean {
  if (!local.sourceUpdatedAt) return true;
  const l = local.sourceUpdatedAt.getTime();
  const r = remote.sourceUpdatedAt.getTime();
  if (r > l) return true;
  if (r < l) return false;
  return remote.stateHash !== local.stateHash;
}

/** Exponential backoff with full jitter (TZ §19.3). */
export function backoffDelayMs(attempt: number, baseMs = 2_000, capMs = 6 * 3_600_000, random = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * exp);
}

export type ErrorClass = 'transient' | 'rate_limited' | 'unauthorized' | 'validation' | 'forbidden' | 'billing' | 'unknown_outcome';

export interface RetryDecision {
  action: 'retry' | 'refresh_token' | 'dead_letter' | 'pause_connection' | 'unknown';
  delayMs: number | null;
}

/** Retry policy table (TZ §19.3). */
export function decideRetry(cls: ErrorClass, attempt: number, opts: { maxAttempts?: number; retryAfterMs?: number | null; firstAttemptAt?: Date; now?: Date } = {}): RetryDecision {
  const max = opts.maxAttempts ?? 8;
  const now = opts.now ?? new Date();
  const overDuration = opts.firstAttemptAt ? now.getTime() - opts.firstAttemptAt.getTime() > 24 * 3_600_000 : false;
  switch (cls) {
    case 'transient':
      if (attempt >= max || overDuration) return { action: 'dead_letter', delayMs: null };
      return { action: 'retry', delayMs: Math.max(1_000, backoffDelayMs(attempt)) };
    case 'rate_limited':
      if (attempt >= max || overDuration) return { action: 'dead_letter', delayMs: null };
      return { action: 'retry', delayMs: opts.retryAfterMs ?? Math.max(1_000, backoffDelayMs(attempt)) };
    case 'unauthorized':
      return attempt <= 1 ? { action: 'refresh_token', delayMs: 0 } : { action: 'pause_connection', delayMs: null };
    case 'validation':
      return { action: 'dead_letter', delayMs: null };
    case 'forbidden':
    case 'billing':
      return { action: 'pause_connection', delayMs: null };
    case 'unknown_outcome':
      return { action: 'unknown', delayMs: null };
  }
}
