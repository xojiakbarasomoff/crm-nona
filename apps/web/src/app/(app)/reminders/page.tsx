'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, fmtDateTime, useApi, type ApiError } from '../../../lib/api';
import { Async, Badge, FormError } from '../../../components/ui';
import { OCCURRENCE_STATE_LABELS } from '../../../lib/format';
import { canWrite, useMe } from '../../../components/shell';

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
  const me = useMe();
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
      <h1>Напоминания</h1>
      <div className="tabs">
        {[
          ['', 'Активные'],
          ['due', 'Пора выполнить'],
          ['completed', 'Выполненные'],
          ['missed', 'Пропущенные'],
          ['cancelled', 'Отменённые'],
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
                  <th>Напоминание</th>
                  <th>Срок</th>
                  <th>Статус</th>
                  <th>Действие</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <b>{r.title}</b> {r.escalatedAt && <Badge tone="bad">Эскалация</Badge>}
                      <div className="muted">{r.body}</div>
                      {r.orderId && <Link href={`/orders/${r.orderId}`}>Открыть заказ</Link>}
                    </td>
                    <td>{fmtDateTime(r.dueAt)}</td>
                    <td>
                      <Badge tone={r.state === 'due' ? 'warn' : 'neutral'}>{OCCURRENCE_STATE_LABELS[r.state] ?? r.state}</Badge>
                      {r.kind === 'milestone' && r.state === 'due' && <div className="hint">Нужно ввести результат (проверка рейса в заказе)</div>}
                    </td>
                    <td>
                      {canWrite(me) && ['scheduled', 'due', 'snoozed'].includes(r.state) && (
                        <>
                          <button className="btn small secondary" type="button" onClick={() => act(() => api(`/api/v1/reminders/${r.id}`, { method: 'PATCH', body: { action: 'snooze', minutes: 30 } }))}>
                            Отложить на 30 мин.
                          </button>
                          {r.kind === 'manual' && (
                            <button className="btn small" type="button" onClick={() => act(() => api(`/api/v1/reminders/${r.id}/complete`, { method: 'POST', body: {} }))}>
                              Выполнено
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
