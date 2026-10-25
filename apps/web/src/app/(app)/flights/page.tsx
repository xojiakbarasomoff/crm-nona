'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CHECK_LABELS, fmtDateTime, OP_STATUS_LABELS, useApi } from '../../../lib/api';
import { Async, Badge } from '../../../components/ui';

interface Row {
  id: string;
  orderId: string;
  orderNo: string;
  customer: string | null;
  ownerName: string | null;
  originIata: string;
  destinationIata: string;
  marketingCarrier: string;
  flightNumber: string;
  departureAtUtc: string | null;
  departureLocal: string | null;
  departureTimezone: string;
  checkState: string;
  operationalStatus: string;
  lastCheckedAt: string | null;
  nextReminderAt: string | null;
  pnr: string | null;
}

const FILTERS: Array<[string, string]> = [
  ['', 'Все'],
  ['today', 'Сегодня'],
  ['24h', 'В течение 24 часов'],
  ['7d', 'В течение 7 дней'],
  ['overdue', 'Проверка просрочена'],
  ['changed', 'Время изменилось'],
];

export default function FlightsPage() {
  const [filter, setFilter] = useState('');
  const state = useApi<{ items: Row[]; generatedAt: string }>(`/api/v1/flights?limit=200${filter ? `&filter=${filter}` : ''}`);
  return (
    <>
      <h1>Рейсы</h1>
      <p className="muted">Начиная с ближайшего вылета. Данные о статусе введены вручную — подключения к онлайн-данным о рейсах нет.</p>
      <div className="tabs" role="group" aria-label="Быстрые фильтры">
        {FILTERS.map(([k, v]) => (
          <button key={k} type="button" className="btn secondary" aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {v}
          </button>
        ))}
      </div>
      <Async state={state} isEmpty={(d) => d.items.length === 0}>
        {(d) => (
          <div className="card table-wrap">
            <p className="muted">Обновлено: {fmtDateTime(d.generatedAt)}</p>
            <table>
              <thead>
                <tr>
                  <th>Вылет (время аэропорта)</th>
                  <th>Рейс</th>
                  <th>Маршрут</th>
                  <th>Клиент / заказ</th>
                  <th>Ответственный</th>
                  <th>Проверка</th>
                  <th>Последняя проверка</th>
                  <th>Следующее напоминание</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.departureLocal ? s.departureLocal.replace('T', ' ') : '—'}
                      <div className="muted">
                        {s.departureTimezone} · Ташкент {fmtDateTime(s.departureAtUtc)}
                      </div>
                    </td>
                    <td>
                      {s.marketingCarrier} {s.flightNumber}
                    </td>
                    <td>
                      {s.originIata}–{s.destinationIata}
                    </td>
                    <td>
                      {s.customer ?? '—'} · <Link href={`/orders/${s.orderId}`}>{s.orderNo}</Link>
                    </td>
                    <td>{s.ownerName ?? '—'}</td>
                    <td>
                      <Badge tone={s.checkState === 'checked' ? 'ok' : s.checkState === 'due' || s.checkState === 'recheck_required' ? 'warn' : 'neutral'}>{CHECK_LABELS[s.checkState]}</Badge>{' '}
                      {s.operationalStatus !== 'scheduled' && <Badge tone={s.operationalStatus === 'cancelled' ? 'bad' : 'warn'}>{OP_STATUS_LABELS[s.operationalStatus]}</Badge>}
                    </td>
                    <td>{fmtDateTime(s.lastCheckedAt)}</td>
                    <td>{fmtDateTime(s.nextReminderAt)}</td>
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
