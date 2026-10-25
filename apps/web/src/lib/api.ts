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
    throw new ApiError(0, 'NETWORK', 'Нет связи с сервером. Проверьте подключение к интернету.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && typeof window !== 'undefined' && !path.includes('/auth/')) window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `Ошибка ${res.status}`, e.field_errors ?? {}, e.details ?? {});
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
export function useApi<T>(path: string | null, opts: { pollMs?: number; live?: boolean; reset?: boolean } = {}): Loadable<T> {
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
      const fresh = await api<T>(p);
      if (pathRef.current !== p) return; // boshqa so'rov (filtr) almashgan: eski javob yangi natija bo'lib qolmasin
      setData(fresh);
      setError(null);
      setLoadedAt(new Date());
    } catch (e) {
      if (pathRef.current === p) setError(e as ApiError);
    } finally {
      if (pathRef.current === p) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // `reset`: so'rov manzili o'zgarganda (masalan, yangi sana oralig'i) eski natija va xato tozalanadi.
    if (opts.reset) {
      setData(null);
      setError(null);
    }
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

/** Yagona ko'rinish: «18:36 · 25.10.2026» (kompaniya vaqt zonasi; bazadagi qiymat siljitilmaydi, faqat ko'rsatiladi). */
const dtParts = (d: Date, zone: string) => {
  const o: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d)) o[p.type] = p.value;
  return o;
};
export const fmtDateTime = (iso: string | null | undefined, zone = 'Asia/Tashkent') => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = dtParts(d, zone);
  return `${p.hour}:${p.minute} · ${p.day}.${p.month}.${p.year}`;
};
/** Faqat sana: «25.10.2026». «YYYY-MM-DD» (sana-only) qiymat vaqt zonasi bilan siljitilmaydi. */
export const fmtDate = (iso: string | null | undefined, zone = 'Asia/Tashkent') => {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = dtParts(d, zone);
  return `${p.day}.${p.month}.${p.year}`;
};
/** «DD.MM.YYYY» → «YYYY-MM-DD» (haqiqiy kalendar sanasi bo'lmasa null). */
export const parseDmy = (text: string): string | null => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const dt = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  return dt.getUTCFullYear() === Number(yyyy) && dt.getUTCMonth() === Number(mm) - 1 && dt.getUTCDate() === Number(dd) ? `${yyyy}-${mm}-${dd}` : null;
};
export const isoToDmy = (iso: string) => fmtDate(iso);
/** «DD.MM.YYYY HH:mm» → «YYYY-MM-DDTHH:mm» (haqiqiy sana-vaqt bo'lmasa null). Aeroport/mahalliy vaqt maydonlari uchun ham ishlatiladi. */
export const parseDmyHm = (text: string): string | null => {
  const m = /^(\d{2}\.\d{2}\.\d{4}) (\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const date = parseDmy(m[1]!);
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  return date && hh < 24 && mm < 60 ? `${date}T${m[2]}:${m[3]}` : null;
};
export const localToDmyHm = (local: string) => (local ? `${fmtDate(local.slice(0, 10))} ${local.slice(11, 16)}` : '');
/** Toshkent vaqti (UTC+5, yozgi vaqt yo'q) bilan ISO ↔ «YYYY-MM-DDTHH:mm». Bazadagi vaqt qiymati o'zgarmaydi, faqat ko'rsatish/kiritish. */
export const isoToTashkentLocal = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = dtParts(d, 'Asia/Tashkent');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
export const tashkentLocalToIso = (local: string) => new Date(`${local}:00+05:00`).toISOString();

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const STAGE_LABELS: Record<string, string> = {
  NEW: 'Новый лид',
  CONTACTED: 'Контакт установлен',
  QUALIFIED: 'Потребности выяснены',
  PREPARING_OFFER: 'Готовится предложение',
  OFFER_SENT: 'Предложение отправлено',
  AWAITING_PAYMENT: 'Ожидается оплата',
  WON: 'Продажа завершена',
  LOST: 'Отменён',
  FOLLOW_UP: 'Повторный контакт',
};

export const SOURCE_LABELS: Record<string, string> = {
  instagram_lead_ads: 'Instagram Lead Ads',
  meta_lead_ads: 'Meta Lead Ads (место неизвестно)',
  instagram_direct: 'Instagram Direct',
  amocrm: 'Прежняя система',
  manual: 'Добавлен вручную',
  other: 'Другое',
};

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  MANAGER: 'Менеджер',
  USER: 'Пользователь',
};

export const CHECK_LABELS: Record<string, string> = {
  pending: 'Ожидает проверки',
  due: 'Пора проверить',
  in_progress: 'Рейс проверяется',
  checked: 'Данные рейса проверены',
  recheck_required: 'Нужна повторная проверка',
};

export const OP_STATUS_LABELS: Record<string, string> = {
  scheduled: 'По расписанию',
  schedule_changed: 'Время рейса изменилось',
  cancelled: 'Рейс отменён',
  departed: 'Вылетел',
};
