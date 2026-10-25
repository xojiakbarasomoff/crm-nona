'use client';

import Link from 'next/link';
import { useState } from 'react';
import { fmtDateTime, useApi } from '../../../lib/api';
import { Async, Badge } from '../../../components/ui';
import { FULFILLMENT_LABELS, PAYMENT_LABELS, TICKETING_LABELS } from '../../../lib/format';

interface Row {
  id: string;
  orderNo: string;
  fulfillmentState: string;
  paymentState: string;
  ticketingState: string;
  agreedAmount: string | null;
  currency: string | null;
  createdAt: string;
}

export default function OrdersPage() {
  const [cursor, setCursor] = useState<string | undefined>();
  const state = useApi<{ items: Row[]; nextCursor: string | null }>(`/api/v1/orders?limit=50${cursor ? `&cursor=${cursor}` : ''}`);
  return (
    <>
      <h1>Заказы</h1>
      <Async state={state} isEmpty={(d) => d.items.length === 0}>
        {(d) => (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Номер</th>
                  <th>Статус</th>
                  <th>Оплата</th>
                  <th>Билеты</th>
                  <th>Сумма</th>
                  <th>Создан</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/orders/${o.id}`}>{o.orderNo}</Link>
                    </td>
                    <td>
                      <Badge tone={o.fulfillmentState === 'cancelled' ? 'bad' : 'neutral'}>{FULFILLMENT_LABELS[o.fulfillmentState] ?? o.fulfillmentState}</Badge>
                    </td>
                    <td>{PAYMENT_LABELS[o.paymentState] ?? o.paymentState}</td>
                    <td>{TICKETING_LABELS[o.ticketingState] ?? o.ticketingState}</td>
                    <td>{o.agreedAmount ? `${o.agreedAmount} ${o.currency}` : '—'}</td>
                    <td>{fmtDateTime(o.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.nextCursor && (
              <button className="btn secondary" type="button" onClick={() => setCursor(d.nextCursor!)}>
                Следующая страница
              </button>
            )}
          </div>
        )}
      </Async>
    </>
  );
}
