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
  ['', 'Barchasi'],
  ['today', 'Bugun'],
  ['24h', '24 soat ichida'],
  ['7d', '7 kun ichida'],
  ['overdue', 'Tekshiruv kechikkan'],
  ['changed', 'Vaqti o‘zgargan'],
];

export default function FlightsPage() {
  const [filter, setFilter] = useState('');
  const state = useApi<{ items: Row[]; generatedAt: string }>(`/api/v1/flights?limit=200${filter ? `&filter=${filter}` : ''}`);
  return (
    <>
      <h1>Reyslar</h1>
      <p className="muted">Eng yaqin jo‘nashdan boshlab. Holat ma’lumotlari qo‘lda tekshiruv natijasi — jonli reys API ulanmagan.</p>
      <div className="tabs" role="group" aria-label="Tezkor filtrlar">
        {FILTERS.map(([k, v]) => (
          <button key={k} type="button" className="btn secondary" aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {v}
          </button>
        ))}
      </div>
      <Async state={state} isEmpty={(d) => d.items.length === 0}>
        {(d) => (
          <div className="card table-wrap">
            <p className="muted">Yangilangan: {fmtDateTime(d.generatedAt)}</p>
            <table>
              <thead>
                <tr>
                  <th>Jo‘nash (aeroport vaqti)</th>
                  <th>Reys</th>
                  <th>Yo‘nalish</th>
                  <th>Mijoz / buyurtma</th>
                  <th>Mas’ul</th>
                  <th>Tekshiruv</th>
                  <th>Oxirgi tekshiruv</th>
                  <th>Keyingi eslatma</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.departureLocal ? s.departureLocal.replace('T', ' ') : '—'}
                      <div className="muted">
                        {s.departureTimezone} · Toshkent {fmtDateTime(s.departureAtUtc)}
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
