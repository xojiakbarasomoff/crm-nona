'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, useApi, type ApiError } from '../lib/api';
import { Loading } from './ui';

export interface Me {
  id: string;
  email: string;
  fullName: string;
  role: 'ADMIN' | 'HEAD' | 'MANAGER';
  capabilities: string[];
  mfa: { required: boolean; enrolled: boolean; verified: boolean };
  appMode: 'demo' | 'staging' | 'production';
}

const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext)!;
export const canDo = (me: Me, cap: string) => me.capabilities.includes(cap);

/** Connects to the SSE stream; every change event triggers a refetch in mounted views. */
function useRealtime(enabled: boolean) {
  const [live, setLive] = useState<'live' | 'polling'>('polling');
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/v1/events');
    es.addEventListener('ready', () => setLive('live'));
    es.addEventListener('change', () => window.dispatchEvent(new Event('crm:change')));
    es.onerror = () => setLive('polling');
    return () => es.close();
  }, [enabled]);
  return live;
}

export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const live = useRealtime(!!me && me.mfa.verified !== false);
  const notifications = useApi<{ items: Array<{ id: string; readAt: string | null }> }>(me ? '/api/v1/notifications' : null);

  useEffect(() => {
    api<Me>('/api/v1/me')
      .then((m) => {
        setMe(m);
        if (m.mfa.required && !m.mfa.verified && pathname !== '/mfa') router.replace('/mfa');
      })
      .catch((e: ApiError) => {
        setError(e);
        if (e.status === 401) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      });
  }, [pathname, router]);

  if (!me) return error && error.status !== 401 ? <div className="state error">{error.message}</div> : <Loading label="Sessiya tekshirilmoqda…" />;

  const nav: Array<[string, string, boolean]> = [
    ['/dashboard', 'Dashboard', true],
    ['/leads', 'Lidlar', true],
    ['/orders', 'Buyurtmalar', true],
    ['/flights', 'Reyslar', true],
    ['/reminders', 'Eslatmalar', true],
    ['/duplicates', 'Dublikatlar', true],
    ['/integrations', 'Integratsiyalar', canDo(me, 'integrations.manage') || canDo(me, 'dashboard.company')],
    ['/users', 'Foydalanuvchilar', canDo(me, 'users.manage')],
    ['/settings', 'Sozlamalar', canDo(me, 'integrations.manage')],
  ];
  const unread = notifications.data?.items.filter((n) => !n.readAt).length ?? 0;

  return (
    <MeContext.Provider value={me}>
      {me.appMode === 'demo' && (
        <div className="demo-banner" role="note">
          DEMO REJIM — tashqi provayderlar soxta adapter bilan ishlaydi, real mijozga xabar yuborilmaydi. Barcha ma’lumotlar sun’iy.
        </div>
      )}
      <div className="layout">
        <aside className="sidebar">
          <div className="brand">Turizm CRM</div>
          <nav aria-label="Asosiy bo‘limlar">
            {nav
              .filter(([, , show]) => show)
              .map(([href, label]) => (
                <Link key={href} href={href} className={pathname.startsWith(href) ? 'active' : ''} aria-current={pathname.startsWith(href) ? 'page' : undefined}>
                  {label}
                </Link>
              ))}
          </nav>
          <div className="sidebar-foot">
            <div>{me.fullName}</div>
            <div className="muted">{me.role === 'ADMIN' ? 'Administrator' : me.role === 'HEAD' ? 'Rahbar' : 'Menejer'}</div>
            <div className="muted" title="Realtime holati">
              {live === 'live' ? '● Jonli yangilanish' : '○ 30 s polling'}
            </div>
            <Link href="/notifications">Bildirishnomalar {unread > 0 && <span className="badge bad">{unread}</span>}</Link>
            <button
              type="button"
              className="btn link"
              onClick={async () => {
                await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
                router.replace('/login');
              }}
            >
              Chiqish
            </button>
          </div>
        </aside>
        <main className="content">{children}</main>
      </div>
    </MeContext.Provider>
  );
}
