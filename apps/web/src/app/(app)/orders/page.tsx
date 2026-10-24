'use client';

import Link from 'next/link';
import { useState } from 'react';
import { fmtDateTime, useApi } from '../../../lib/api';
import { Async, Badge } from '../../../components/ui';

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
      <h1>Buyurtmalar</h1>
      <Async state={state} isEmpty={(d) => d.items.length === 0}>
        {(d) => (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Raqam</th>
                  <th>Xizmat</th>
                  <th>To‘lov</th>
                  <th>Chipta</th>
                  <th>Summa</th>
                  <th>Yaratilgan</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/orders/${o.id}`}>{o.orderNo}</Link>
                    </td>
                    <td>
                      <Badge tone={o.fulfillmentState === 'cancelled' ? 'bad' : 'neutral'}>{o.fulfillmentState}</Badge>
                    </td>
                    <td>{o.paymentState}</td>
                    <td>{o.ticketingState}</td>
                    <td>{o.agreedAmount ? `${o.agreedAmount} ${o.currency}` : '—'}</td>
                    <td>{fmtDateTime(o.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.nextCursor && (
              <button className="btn secondary" type="button" onClick={() => setCursor(d.nextCursor!)}>
                Keyingi sahifa
              </button>
            )}
          </div>
        )}
      </Async>
    </>
  );
}
