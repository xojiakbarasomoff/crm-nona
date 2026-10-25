'use client';

import type { ReactNode } from 'react';
import type { ApiError, Loadable } from '../lib/api';

export function Loading({ label = 'Yuklanmoqda…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      {label}
    </div>
  );
}

export function Empty({ children = 'Ma’lumot yo‘q' }: { children?: ReactNode }) {
  return <div className="state empty">{children}</div>;
}

export function ErrorBox({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  if (error.status === 403) return <div className="state denied" role="alert">Ruxsat yo‘q: bu bo‘limni ko‘rish huquqingiz yo‘q.</div>;
  if (error.status === 404) return <div className="state denied" role="alert">Topilmadi yoki sizga ochiq emas.</div>;
  return (
    <div className="state error" role="alert">
      <strong>Xato:</strong> {error.message}
      {onRetry && (
        <button type="button" className="btn small" onClick={onRetry}>
          Qayta urinish
        </button>
      )}
    </div>
  );
}

/** Renders loading / error / permission / empty states consistently (TZ §20.2). */
export function Async<T>({ state, children, isEmpty }: { state: Loadable<T>; children: (data: T) => ReactNode; isEmpty?: (d: T) => boolean }) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error && !state.data) return <ErrorBox error={state.error} onRetry={() => void state.reload()} />;
  if (!state.data) return <Empty />;
  if (isEmpty?.(state.data)) return <Empty />;
  return (
    <>
      {state.error && <StaleNotice error={state.error} loadedAt={state.loadedAt} />}
      {children(state.data)}
    </>
  );
}

export function StaleNotice({ error, loadedAt }: { error: ApiError; loadedAt: Date | null }) {
  return (
    <div className="state stale" role="status">
      Ma’lumotlar eskirgan: so‘nggi yangilanish {loadedAt ? loadedAt.toLocaleTimeString('uz-Latn-UZ') : '—'} ({error.message})
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/** Mijozning Instagram username'i va profiliga havola (username faqat harf/raqam/nuqta/pastki chiziq; boshqa belgi bo'lsa havola berilmaydi). */
export function InstagramLink({ username, withHandle = true }: { username: string | null | undefined; withHandle?: boolean }) {
  if (!username || !/^[A-Za-z0-9._]{1,30}$/.test(username)) return null;
  return (
    <a className="ig-link" href={`https://www.instagram.com/${encodeURIComponent(username)}/`} target="_blank" rel="noopener noreferrer" title="Instagram profilini ochish">
      {withHandle ? `@${username}` : 'Instagram'} ↗
    </a>
  );
}

export function Field({ label, error, children, hint }: { label: string; error?: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export function FormError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const fields = Object.entries(error.fieldErrors);
  return (
    <div className="state error" role="alert">
      {error.message}
      {fields.length > 0 && (
        <ul>
          {fields.map(([k, v]) => (
            <li key={k}>
              <code>{k}</code>: {v}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function SyncBadge({ state }: { state: string }) {
  if (state === 'synced') return <Badge tone="ok">amoCRM bilan sinxron</Badge>;
  if (state === 'pending' || state === 'pending_create') return <Badge tone="info">Sinxronlanmoqda</Badge>;
  if (state === 'unknown') return <Badge tone="bad">Natija noma’lum — operator tekshiradi</Badge>;
  if (state === 'conflict') return <Badge tone="warn">Ziddiyat</Badge>;
  return <Badge tone="warn">{state}</Badge>;
}
