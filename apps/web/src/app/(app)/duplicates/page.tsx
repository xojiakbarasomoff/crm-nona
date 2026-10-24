'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, fmtDateTime, useApi, type ApiError } from '../../../lib/api';
import { Async, FormError } from '../../../components/ui';
import { canDo, useMe } from '../../../components/shell';

interface Cand {
  id: string;
  contactIds: string[];
  reason: string;
  identifier: { type: string; value: string };
  createdAt: string;
  flaggedById: string | null;
}

const REASONS: Record<string, string> = {
  phone_points_to_other_contact: 'Telefon va Instagram turli kontaktni ko‘rsatadi',
  shared_identifier: 'Umumiy (oilaviy) identifikator',
  multiple_candidates: 'Bir nechta nomzod',
  conflicting_provider_id: 'Ziddiyatli provider ID',
};

export default function DuplicatesPage() {
  const me = useMe();
  const state = useApi<{ items: Cand[] }>('/api/v1/duplicates');
  const [error, setError] = useState<ApiError | null>(null);
  const act = async (id: string, body: Record<string, unknown>) => {
    setError(null);
    try {
      await api(`/api/v1/duplicates/${id}/resolve`, { method: 'POST', body });
      await state.reload();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  return (
    <>
      <h1>Dublikat nomzodlari</h1>
      <p className="muted">Avtomatik birlashtirish yo‘q. Rahbar asosiy kontaktni tanlab tasdiqlaydi; menejer faqat belgilaydi.</p>
      <FormError error={error} />
      <Async state={state} isEmpty={(d) => d.items.length === 0}>
        {(d) => (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sabab</th>
                  <th>Identifikator</th>
                  <th>Kontaktlar</th>
                  <th>Vaqt</th>
                  <th>Qaror</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((c) => (
                  <tr key={c.id}>
                    <td>{REASONS[c.reason] ?? c.reason}</td>
                    <td>
                      {c.identifier.type}: <code>{c.identifier.value}</code>
                    </td>
                    <td>
                      {c.contactIds.map((id) => (
                        <div key={id}>
                          <Link href={`/contacts/${id}`}>{id.slice(0, 8)}</Link>
                        </div>
                      ))}
                    </td>
                    <td>{fmtDateTime(c.createdAt)}</td>
                    <td>
                      {canDo(me, 'duplicates.resolve') ? (
                        <>
                          <button className="btn small secondary" type="button" onClick={() => act(c.id, { action: 'dismiss' })}>
                            Turli shaxslar
                          </button>
                          {c.identifier.type !== 'instagram_scoped' && (
                            <button className="btn small secondary" type="button" onClick={() => act(c.id, { action: 'mark_shared' })}>
                              Umumiy raqam
                            </button>
                          )}
                          <button className="btn small" type="button" onClick={() => act(c.id, { action: 'merge', primaryContactId: c.contactIds[0] })}>
                            Birinchisiga birlashtirish
                          </button>
                        </>
                      ) : (
                        <button className="btn small" type="button" disabled={!!c.flaggedById} onClick={() => act(c.id, { action: 'flag' })}>
                          {c.flaggedById ? 'Belgilangan' : 'Rahbarga belgilash'}
                        </button>
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
