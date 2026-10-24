import type { ErrorClass } from '@crm/domain';

/**
 * Minimal HTTP helper shared by provider adapters. It classifies errors according to the retry
 * policy (TZ §19.3) and distinguishes "unknown outcome" for mutations that timed out.
 */

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly errorClass: ErrorClass,
    readonly status: number | null,
    readonly retryAfterMs: number | null = null,
    readonly providerCode: string | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function classifyStatus(status: number, body: string): ErrorClass {
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'unauthorized';
  if (status === 402) return 'billing';
  if (status === 403) return /payment|tariff|blocked/i.test(body) ? 'billing' : 'forbidden';
  if (status >= 500) return 'transient';
  return 'validation';
}

export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Whether the call creates or changes remote state. Timeouts of mutations become unknown_outcome. */
  mutation?: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function requestJson<T>(url: string, opts: RequestOptions = {}, fetchImpl: FetchLike = fetch): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
      redirect: 'error',
    });
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    if (opts.mutation) throw new ProviderError(`Request outcome unknown: ${aborted ? 'timeout' : (err as Error).message}`, 'unknown_outcome', null);
    throw new ProviderError(`Network error: ${aborted ? 'timeout' : (err as Error).message}`, 'transient', null);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    const cls = classifyStatus(res.status, text);
    throw new ProviderError(`HTTP ${res.status}: ${redactBody(text)}`, cls, res.status, parseRetryAfter(res.headers.get('retry-after')));
  }
  if (res.status === 204 || text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError('Invalid JSON from provider', opts.mutation ? 'unknown_outcome' : 'transient', res.status);
  }
}

/** Removes anything that looks like a token from provider error bodies before logging. */
export function redactBody(text: string): string {
  return text
    .slice(0, 500)
    .replace(/("?(access_token|refresh_token|client_secret|token|secret)"?\s*[:=]\s*"?)[^",&\s]+/gi, '$1[REDACTED]');
}
