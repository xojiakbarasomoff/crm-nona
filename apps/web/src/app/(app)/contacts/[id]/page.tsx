'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, fmtDateTime, SOURCE_LABELS, STAGE_LABELS, useApi, type ApiError } from '../../../../lib/api';
import { useState } from 'react';
import { useMe } from '../../../../components/shell';
import { Async, Badge, FormError, Section } from '../../../../components/ui';
import { Attachments } from '../../../../components/attachments';

interface ContactView {
  contact: { id: string; fullName: string | null; primaryPhone: string | null; primaryEmail: string | null; amoContactId: string | null; piiErasedAt: string | null };
  identifiers: Array<{ id: string; type: string; value: string; shared: boolean; verified: boolean; displayUsername: string | null }>;
  leads: Array<{ id: string; name: string; stage: string }>;
  inquiries: Array<{ id: string; channel: string; placement: string; receivedAt: string; enrichmentState: string }>;
  orders: Array<{ id: string; orderNo: string; fulfillmentState: string; paymentState: string }>;
  conversations: Array<{ id: string; amoChatAvailable: boolean; historyAvailableFrom: string | null; messages: Array<{ id: string; direction: string; content: string | null; state: string; actorType: string; createdAt: string; type: string }> }>;
}

export default function ContactPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<ContactView>(`/api/v1/contacts/${id}`);
  const me = useMe();
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <Async state={state}>
      {(d) => (
        <>
          <h1>{d.contact.fullName ?? 'Ismsiz mijoz'}</h1>
          <p className="muted">
            {d.contact.primaryPhone ?? 'Telefon yo‘q'} · {d.contact.primaryEmail ?? 'Email yo‘q'} · amoCRM kontakt: {d.contact.amoContactId ?? 'hali yaratilmagan'}
          </p>
          {d.contact.piiErasedAt && <div className="state stale">Shaxsiy ma’lumotlar {fmtDateTime(d.contact.piiErasedAt)} da o‘chirilgan. Moliyaviy yozuvlar siyosat bo‘yicha saqlanadi.</div>}
          {me.role === 'ADMIN' && !d.contact.piiErasedAt && (
            <button
              type="button"
              className="btn danger"
              onClick={async () => {
                const reason = window.prompt('Shaxsiy ma’lumotlarni o‘chirish sababi (qaytarib bo‘lmaydi)');
                if (!reason) return;
                try {
                  await api(`/api/v1/contacts/${id}/erase`, { method: 'POST', body: { reason } });
                  await state.reload();
                } catch (e) {
                  setError(e as ApiError);
                }
              }}
            >
              Shaxsiy ma’lumotlarni o‘chirish
            </button>
          )}
          <FormError error={error} />
          <div className="split">
            <div>
              {d.conversations.map((c) => (
                <Section key={c.id} title="Instagram Direct yozishmasi">
                  <p className="muted">
                    Tarix {fmtDateTime(c.historyAvailableFrom)} dan mavjud. Javob yozish joyi — amoCRM native chati{c.amoChatAvailable ? ' (chat ulangan)' : ' (chat hali yaratilmagan)'}.
                  </p>
                  <div className="chat">
                    {c.messages.map((m) => (
                      <div key={m.id} className={`msg ${m.direction === 'inbound' ? 'in' : 'out'}`}>
                        <div>{m.content ?? `[${m.type}]`}</div>
                        <div className="muted">
                          {fmtDateTime(m.createdAt)} · {m.actorType} · {m.state}
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              ))}
              <Section title="Murojaatlar">
                <ul>
                  {d.inquiries.map((i) => (
                    <li key={i.id}>
                      {fmtDateTime(i.receivedAt)} — {SOURCE_LABELS[i.channel] ?? i.channel} ({i.placement}) {i.enrichmentState === 'failed' && <Badge tone="warn">Kampaniya ma’lumoti olinmadi</Badge>}
                    </li>
                  ))}
                </ul>
              </Section>
            </div>
            <div>
              <Section title="Identifikatorlar">
                <ul>
                  {d.identifiers.map((i) => (
                    <li key={i.id}>
                      {i.type}: <code>{i.value}</code> {i.displayUsername && `(@${i.displayUsername})`} {i.shared && <Badge tone="warn">Umumiy</Badge>} {!i.verified && <Badge>Tasdiqlanmagan</Badge>}
                    </li>
                  ))}
                </ul>
              </Section>
              <Section title="Lidlar">
                {d.leads.map((l) => (
                  <div key={l.id}>
                    <Link href={`/leads/${l.id}`}>{l.name}</Link> — {STAGE_LABELS[l.stage]}
                  </div>
                ))}
              </Section>
              <Attachments ownerType="contact" ownerId={id} title="Mijoz hujjatlari" />
              <Section title="Buyurtmalar">
                {d.orders.map((o) => (
                  <div key={o.id}>
                    <Link href={`/orders/${o.id}`}>{o.orderNo}</Link> <Badge>{o.fulfillmentState}</Badge> <Badge>{o.paymentState}</Badge>
                  </div>
                ))}
              </Section>
            </div>
          </div>
        </>
      )}
    </Async>
  );
}
