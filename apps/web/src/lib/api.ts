'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: Record<string, string> = {},
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function csrf(): string {
  const m = document.cookie.match(/(?:^|;\s*)crm_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : '';
}

/** Same-origin fetch through the Next.js rewrite; session is an HttpOnly cookie (never in JS). */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf();
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Server bilan aloqa yo‘q. Internetni tekshiring.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && typeof window !== 'undefined' && !path.includes('/auth/')) window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `Xato ${res.status}`, e.field_errors ?? {}, e.details ?? {});
  }
  return data as T;
}

export interface Loadable<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** When the data was last successfully fetched. */
  loadedAt: Date | null;
  reload: () => Promise<void>;
}

/** Loads data, reloads on SSE change events and every 30 s as a polling fallback (TZ §15.3). */
export function useApi<T>(path: string | null, opts: { pollMs?: number; live?: boolean } = {}): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(async () => {
    const p = pathRef.current;
    if (!p) return;
    setLoading(true);
    try {
      setData(await api<T>(p));
      setError(null);
      setLoadedAt(new Date());
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [path, reload]);

  useEffect(() => {
    if (!path) return;
    const t = setInterval(() => void reload(), opts.pollMs ?? 30_000);
    const onChange = () => void reload();
    if (opts.live !== false) window.addEventListener('crm:change', onChange);
    return () => {
      clearInterval(t);
      window.removeEventListener('crm:change', onChange);
    };
  }, [path, reload, opts.pollMs, opts.live]);

  return { data, error, loading, loadedAt, reload };
}

export const fmtDateTime = (iso: string | null | undefined, zone = 'Asia/Tashkent') =>
  iso ? new Intl.DateTimeFormat('uz-Latn-UZ', { timeZone: zone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const STAGE_LABELS: Record<string, string> = {
  NEW: 'Yangi lid',
  CONTACTED: 'Aloqa o‘rnatildi',
  QUALIFIED: 'Talablar aniqlandi',
  PREPARING_OFFER: 'Taklif tayyorlanmoqda',
  OFFER_SENT: 'Taklif yuborildi',
  AWAITING_PAYMENT: 'To‘lov kutilmoqda',
  WON: 'Sotuv yakunlandi',
  LOST: 'Bekor qilindi',
  FOLLOW_UP: 'Qayta aloqa',
};

export const SOURCE_LABELS: Record<string, string> = {
  instagram_lead_ads: 'Instagram Lead Ads',
  meta_lead_ads: 'Meta Lead Ads (joy noma’lum)',
  instagram_direct: 'Instagram Direct',
  amocrm: 'amoCRM',
  manual: 'Qo‘lda kiritilgan',
  other: 'Boshqa',
};

export const CHECK_LABELS: Record<string, string> = {
  pending: 'Tekshirish kutilmoqda',
  due: 'Tekshiruv vaqti keldi',
  in_progress: 'Reys tekshirilmoqda',
  checked: 'Reys ma’lumotlari tekshirildi',
  recheck_required: 'Qayta tekshirish talab etiladi',
};

export const OP_STATUS_LABELS: Record<string, string> = {
  scheduled: 'Rejada',
  schedule_changed: 'Reys vaqti o‘zgardi',
  cancelled: 'Reys bekor qilindi',
  departed: 'Uchib ketdi',
};
