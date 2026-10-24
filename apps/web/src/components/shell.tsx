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


const ICONS: Record<string, string> = {
  '/dashboard': '<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>',
  '/leads': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  '/orders': '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/>',
  '/flights': '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  '/reminders': '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  '/duplicates': '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  '/integrations': '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  '/users': '<circle cx="9" cy="8" r="4"/><path d="M2 21v-1a7 7 0 0 1 14 0v1"/>',
  '/settings': '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
};

function NavIcon({ href }: { href: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[href] ?? '' }} />
  );
}

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
      <div className="layout">
        <aside className="sidebar">
          <div className="brand">
            <img src="/nona-logo-white.png" alt="NONA Travel" width={188} height={103} />
            <span>NONA Travel CRM</span>
          </div>
          <nav aria-label="Asosiy bo‘limlar">
            {nav
              .filter(([, , show]) => show)
              .map(([href, label]) => (
                <Link key={href} href={href} className={pathname.startsWith(href) ? 'active' : ''} aria-current={pathname.startsWith(href) ? 'page' : undefined}>
                  <NavIcon href={href} />
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
        <main className="content">
          {me.appMode === 'demo' && (
            <div className="demo-banner" role="note">
              DEMO REJIM — tashqi provayderlar soxta adapter bilan ishlaydi, real mijozga xabar yuborilmaydi. Barcha ma’lumotlar sun’iy.
            </div>
          )}
          {children}
        </main>
      </div>
    </MeContext.Provider>
  );
}
