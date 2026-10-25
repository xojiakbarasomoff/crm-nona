'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, fmtDateTime, SOURCE_LABELS, STAGE_LABELS, useApi, type ApiError } from '../../../../lib/api';
import { ACTOR_LABELS, FULFILLMENT_LABELS, IDENTIFIER_LABELS, MESSAGE_STATE_LABELS, PAYMENT_LABELS, PLACEMENT_LABELS } from '../../../../lib/format';
import { useState } from 'react';
import { useMe } from '../../../../components/shell';
import { Async, Badge, FormError, InstagramLink, Section } from '../../../../components/ui';
import { Attachments } from '../../../../components/attachments';
import { LeadFormAnswers, type FormInquiry } from '../../../../components/lead-form-answers';

interface ContactView {
  contact: { id: string; fullName: string | null; primaryPhone: string | null; primaryEmail: string | null; piiErasedAt: string | null; instagramUsername: string | null; instagramName: string | null };
  identifiers: Array<{ id: string; type: string; value: string; shared: boolean; verified: boolean; displayUsername: string | null }>;
  leads: Array<{ id: string; name: string; stage: string }>;
  inquiries: Array<FormInquiry & { placement: string; enrichmentState: string }>;
  orders: Array<{ id: string; orderNo: string; fulfillmentState: string; paymentState: string }>;
  conversations: Array<{ id: string; historyAvailableFrom: string | null; messages: Array<{ id: string; direction: string; content: string | null; state: string; actorType: string; createdAt: string; type: string }> }>;
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
          <h1>{d.contact.fullName ?? (d.contact.instagramUsername ? `@${d.contact.instagramUsername}` : 'Клиент без имени')}</h1>
          {d.contact.instagramUsername && (
            <p>
              Instagram: <b>@{d.contact.instagramUsername}</b> <InstagramLink username={d.contact.instagramUsername} withHandle={false} />
              {d.contact.instagramName ? <span className="muted"> · {d.contact.instagramName}</span> : null}
            </p>
          )}
          <p className="muted">
            {d.contact.primaryPhone ?? 'Телефон не указан'} · {d.contact.primaryEmail ?? 'Email не указан'}
          </p>
          {d.contact.piiErasedAt && <div className="state stale">Персональные данные удалены {fmtDateTime(d.contact.piiErasedAt)}. Финансовые записи хранятся по политике компании.</div>}
          {me.role === 'ADMIN' && !d.contact.piiErasedAt && (
            <button
              type="button"
              className="btn danger"
              onClick={async () => {
                const reason = window.prompt('Причина удаления персональных данных (действие необратимо)');
                if (!reason) return;
                try {
                  await api(`/api/v1/contacts/${id}/erase`, { method: 'POST', body: { reason } });
                  await state.reload();
                } catch (e) {
                  setError(e as ApiError);
                }
              }}
            >
              Удалить персональные данные
            </button>
          )}
          <FormError error={error} />
          <div className="split">
            <div>
              {d.conversations.map((c) => (
                <Section key={c.id} title="Переписка в Instagram Direct">
                  <p className="muted">
                    История доступна с {fmtDateTime(c.historyAvailableFrom)}. Отправка ответов из CRM не подключена.
                  </p>
                  <div className="chat">
                    {c.messages.map((m) => (
                      <div key={m.id} className={`msg ${m.direction === 'inbound' ? 'in' : 'out'}`}>
                        <div>{m.content ?? `[${m.type}]`}</div>
                        <div className="muted">
                          {fmtDateTime(m.createdAt)} · {ACTOR_LABELS[m.actorType] ?? m.actorType} · {MESSAGE_STATE_LABELS[m.state] ?? m.state}
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              ))}
              <LeadFormAnswers inquiries={d.inquiries} />
              <Section title="Обращения">
                <ul>
                  {d.inquiries.map((i) => (
                    <li key={i.id}>
                      {fmtDateTime(i.receivedAt)} — {SOURCE_LABELS[i.channel] ?? i.channel} ({PLACEMENT_LABELS[i.placement] ?? i.placement}) {i.enrichmentState === 'failed' && <Badge tone="warn">Данные кампании не получены</Badge>}
                    </li>
                  ))}
                </ul>
              </Section>
            </div>
            <div>
              <Section title="Идентификаторы">
                <ul>
                  {d.identifiers.map((i) => (
                    <li key={i.id}>
                      {IDENTIFIER_LABELS[i.type] ?? i.type}: <code>{i.value}</code> {i.displayUsername && `(@${i.displayUsername})`} {i.shared && <Badge tone="warn">Общий</Badge>} {!i.verified && <Badge>Не подтверждён</Badge>}
                    </li>
                  ))}
                </ul>
              </Section>
              <Section title="Лиды">
                {d.leads.map((l) => (
                  <div key={l.id}>
                    <Link href={`/leads/${l.id}`}>{l.name}</Link> — {STAGE_LABELS[l.stage]}
                  </div>
                ))}
              </Section>
              <Attachments ownerType="contact" ownerId={id} title="Документы клиента" />
              <Section title="Заказы">
                {d.orders.map((o) => (
                  <div key={o.id}>
                    <Link href={`/orders/${o.id}`}>{o.orderNo}</Link> <Badge>{FULFILLMENT_LABELS[o.fulfillmentState] ?? o.fulfillmentState}</Badge> <Badge>{PAYMENT_LABELS[o.paymentState] ?? o.paymentState}</Badge>
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
