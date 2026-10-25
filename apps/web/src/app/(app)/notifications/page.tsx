'use client';

import Link from 'next/link';
import { api, fmtDateTime, useApi } from '../../../lib/api';
import { Async, Badge } from '../../../components/ui';

interface N {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export default function NotificationsPage() {
  const state = useApi<{ items: N[] }>('/api/v1/notifications');
  return (
    <>
      <h1>Уведомления</h1>
      <Async state={state} isEmpty={(d) => d.items.length === 0}>
        {(d) => (
          <div className="card">
            {d.items.map((n) => (
              <div key={n.id} style={{ borderBottom: '1px solid var(--line)', padding: '8px 0' }}>
                {!n.readAt && <Badge tone="info">Новое</Badge>} <b>{n.title}</b> <span className="muted">{fmtDateTime(n.createdAt)}</span>
                {n.body && <div>{n.body}</div>}
                <div className="row">
                  {n.link && (
                    <Link href={n.link} onClick={() => void api(`/api/v1/notifications/${n.id}/read`, { method: 'POST' })}>
                      Открыть
                    </Link>
                  )}
                  {!n.readAt && (
                    <button className="btn small secondary" type="button" onClick={async () => (await api(`/api/v1/notifications/${n.id}/read`, { method: 'POST' }), state.reload())}>
                      Прочитано
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Async>
    </>
  );
}
