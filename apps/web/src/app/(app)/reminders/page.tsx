'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, fmtDateTime, useApi, type ApiError } from '../../../lib/api';
import { Async, Badge, FormError } from '../../../components/ui';

interface Row {
  id: string;
  kind: string;
  milestone: string | null;
  title: string;
  body: string | null;
  dueAt: string;
  state: string;
  orderId: string | null;
  escalatedAt: string | null;
}

export default function RemindersPage() {
  const [stateFilter, setStateFilter] = useState('');
  const state = useApi<{ items: Row[] }>(`/api/v1/reminders?limit=200${stateFilter ? `&state=${stateFilter}` : ''}`);
  const [error, setError] = useState<ApiError | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await state.reload();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  return (
    <>
      <h1>Eslatmalar</h1>
      <div className="tabs">
        {[
          ['', 'Faol'],
          ['due', 'Vaqti kelgan'],
          ['completed', 'Bajarilgan'],
          ['missed', 'O‘tkazib yuborilgan'],
          ['cancelled', 'Bekor qilingan'],
        ].map(([k, v]) => (
          <button key={k} type="button" className="btn secondary" aria-pressed={stateFilter === k} onClick={() => setStateFilter(k!)}>
            {v}
          </button>
        ))}
      </div>
      <FormError error={error} />
      <Async state={state} isEmpty={(d) => d.items.length === 0}>
        {(d) => (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Eslatma</th>
                  <th>Vaqt</th>
                  <th>Holat</th>
                  <th>Amal</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <b>{r.title}</b> {r.escalatedAt && <Badge tone="bad">Eskalatsiya</Badge>}
                      <div className="muted">{r.body}</div>
                      {r.orderId && <Link href={`/orders/${r.orderId}`}>Buyurtmani ochish</Link>}
                    </td>
                    <td>{fmtDateTime(r.dueAt)}</td>
                    <td>
                      <Badge tone={r.state === 'due' ? 'warn' : 'neutral'}>{r.state}</Badge>
                      {r.kind === 'milestone' && r.state === 'due' && <div className="hint">Natija kiritilishi kerak (buyurtmada reys tekshiruvi)</div>}
                    </td>
                    <td>
                      {['scheduled', 'due', 'snoozed'].includes(r.state) && (
                        <>
                          <button className="btn small secondary" type="button" onClick={() => act(() => api(`/api/v1/reminders/${r.id}`, { method: 'PATCH', body: { action: 'snooze', minutes: 30 } }))}>
                            30 daq keyinga
                          </button>
                          {r.kind === 'manual' && (
                            <button className="btn small" type="button" onClick={() => act(() => api(`/api/v1/reminders/${r.id}/complete`, { method: 'POST', body: {} }))}>
                              Bajarildi
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </>
  );
}
