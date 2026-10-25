'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ROLE_LABELS, useApi, type ApiError } from '../lib/api';
import { Icon, type IconName } from './icons';
import { Loading } from './ui';

export interface Me {
  id: string;
  email: string;
  login: string | null;
  fullName: string;
  role: 'ADMIN' | 'MANAGER' | 'USER';
  capabilities: string[];
  mfa: { required: boolean; enrolled: boolean; verified: boolean };
  appMode: 'demo' | 'staging' | 'production';
  liveStatus?: { instagramDirectInboundVerified: boolean };
}

const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext)!;
export const canDo = (me: Me, cap: string) => me.capabilities.includes(cap);
/** Роль «Пользователь» — только просмотр; сервер всё равно отклоняет изменения. */
export const canWrite = (me: Me) => me.role !== 'USER';


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

  if (!me) return error && error.status !== 401 ? <div className="state error">{error.message}</div> : <Loading label="Проверка сеанса…" />;

  const nav: Array<[string, string, boolean]> = [
    ['/dashboard', 'Панель управления', true],
    ['/leads', 'Лиды', true],
    ['/orders', 'Заказы', true],
    ['/suppliers', 'Туроператоры', true],
    ['/flights', 'Рейсы', true],
    ['/reminders', 'Напоминания', true],
    ['/integrations', 'Интеграции', canDo(me, 'integrations.manage') || canDo(me, 'dashboard.company')],
    ['/users', 'Пользователи', canDo(me, 'users.manage')],
    ['/settings', 'Настройки', canDo(me, 'integrations.manage')],
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
          <nav aria-label="Основные разделы">
            {nav
              .filter(([, , show]) => show)
              .map(([href, label]) => (
                <Link key={href} href={href} className={pathname.startsWith(href) ? 'active' : ''} aria-current={pathname.startsWith(href) ? 'page' : undefined}>
                  <Icon name={href.slice(1) as IconName} />
                  {label}
                </Link>
              ))}
          </nav>
          <div className="sidebar-foot">
            <div className="who">
              <span className="avatar" aria-hidden="true">
                {me.fullName.replace(/\(.*?\)/g, '').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
              </span>
              <div>
                <div className="who-name">{me.fullName}</div>
                <div className="muted">{ROLE_LABELS[me.role] ?? me.role}</div>
              </div>
            </div>
            {me.role === 'ADMIN' && (
              <div className="muted" title="Состояние обновления (для администратора)">
                {live === 'live' ? '● Живое обновление' : '○ Периодическое обновление'}
              </div>
            )}
            <Link href="/notifications">Уведомления {unread > 0 && <span className="badge bad">{unread}</span>}</Link>
            <button
              type="button"
              className="btn link"
              onClick={async () => {
                await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
                router.replace('/login');
              }}
            >
              Выйти
            </button>
          </div>
        </aside>
        <main className="content">
          {me.appMode === 'demo' && pathname !== '/dashboard' && (
            <div className="demo-banner" role="note">
              Входящие сообщения Instagram — {me.liveStatus?.instagramDirectInboundVerified ? 'подключены' : 'не проверены'}. Ответы из CRM и рекламные формы — не подключены.
              {canDo(me, 'integrations.manage') && (
                <>
                  {' '}
                  <Link href="/integrations">Подробнее</Link>
                </>
              )}
            </div>
          )}
          {children}
        </main>
      </div>
    </MeContext.Provider>
  );
}
