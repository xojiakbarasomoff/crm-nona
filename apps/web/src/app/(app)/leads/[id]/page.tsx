'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, fmtDateTime, isoToTashkentLocal, newKey, SOURCE_LABELS, STAGE_LABELS, tashkentLocalToIso, useApi, type ApiError } from '../../../../lib/api';
import { FULFILLMENT_LABELS } from '../../../../lib/format';
import { Async, Badge, Field, FormError, InstagramLink, IsoDateField, LocalDateTimeField, Section } from '../../../../components/ui';
import { canDo, canWrite, useMe } from '../../../../components/shell';
import { Attachments } from '../../../../components/attachments';
import { ContactEditForm } from '../../../../components/manual-lead';

interface LeadDetail {
  lead: {
    id: string;
    name: string;
    stage: string;
    version: number;
    ownerId: string | null;
    firstSource: string;
    firstPlacement: string;
    contactId: string;
    tourOperatorId: string | null;
    requirements: Record<string, unknown>;
    serviceType: string | null;
    contactOutcome: string | null;
    offerPrepDueAt: string | null;
    lostReasonCode: string | null;
    nextContactAt: string | null;
    followUpNote: string | null;
    anomaly: { stage: string; missing: string[] } | null;
    firstResponseDueAt: string | null;
    firstHumanActionAt: string | null;
    slaBreachedAt: string | null;
    createdAt: string;
    note: string | null;
  };
  events: Array<{ id: string; kind: string; oldStage: string | null; newStage: string | null; oldOwnerId: string | null; newOwnerId: string | null; origin: string; reason: string | null; effectiveAt: string }>;
  offers: Array<{ id: string; version: number; content: string; amount: string; currency: string; sentAt: string | null; acceptedAt: string | null; validUntil: string | null }>;
  orders: Array<{ id: string; orderNo: string; fulfillmentState: string }>;
  contact: { id: string; fullName: string | null; firstName: string | null; lastName: string | null; primaryPhone: string | null; telegramUsername: string | null; instagramUsername: string | null; instagramName: string | null } | null;
  tourOperator: { id: string; name: string; status: string } | null;
  /** Если есть активный заказ, туроператор принадлежит заказу (историческая связь): в карточке лида не меняется. */
  operatorOwnedByOrder: { id: string; orderNo: string } | null;
}

const EVENT_LABELS: Record<string, string> = {
  created: 'Лид создан',
  stage_change: 'Смена этапа',
  reopened: 'Повторно открыт',
  owner_change: 'Смена ответственного',
};

export default function LeadPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const router = useRouter();
  const state = useApi<LeadDetail>(`/api/v1/leads/${id}`);
  const team = useApi<{ items: Array<{ id: string; fullName: string; role: string }> }>('/api/v1/team');
  const [error, setError] = useState<ApiError | null>(null);
  const [editingContact, setEditingContact] = useState(false);
  const writable = canWrite(me);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await state.reload();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  const userName = (uid: string | null) => team.data?.items.find((u) => u.id === uid)?.fullName ?? '—';

  return (
    <Async state={state}>
      {(d) => {
        const l = d.lead;
        const req = l.requirements as Record<string, string | number | null>;
        return (
          <>
            <h1>{l.name}</h1>
            {d.contact?.instagramUsername && (
              <p>
                Instagram: <b>@{d.contact.instagramUsername}</b> <InstagramLink username={d.contact.instagramUsername} withHandle={false} />
                {d.contact.instagramName ? <span className="muted"> · {d.contact.instagramName}</span> : null}
              </p>
            )}
            <p className="muted">
              Этап: <b>{STAGE_LABELS[l.stage]}</b> · Ответственный: {userName(l.ownerId)} · Источник: {SOURCE_LABELS[l.firstSource] ?? l.firstSource} · Срок первого ответа: {fmtDateTime(l.firstResponseDueAt)}
            </p>
            {l.slaBreachedAt && !l.firstHumanActionAt && <div className="state error">Срок ответа нарушен: первый ответ сотрудника не зафиксирован до {fmtDateTime(l.firstResponseDueAt)}.</div>}
            {l.anomaly && (
              <div className="state stale">
                Аномалия: для этапа «{STAGE_LABELS[l.anomaly.stage]}» не хватает данных — {l.anomaly.missing.join(', ')}. Создана задача на исправление.
              </div>
            )}
            <FormError error={error} />
            <div className="split">
              <div>
                <RequirementsForm lead={l} req={req} readOnly={!writable} onSave={(body) => run(() => api(`/api/v1/leads/${id}`, { method: 'PATCH', body: { version: l.version, ...body } }))} />
                <OffersSection
                  offers={d.offers}
                  readOnly={!writable}
                  onCreate={(body) => run(() => api(`/api/v1/leads/${id}/offers`, { method: 'POST', body, idempotencyKey: newKey() }))}
                  onSent={(oid) => run(() => api(`/api/v1/offers/${oid}/sent`, { method: 'POST', body: { channel: 'instagram_direct' } }))}
                  onAccept={(oid) => run(() => api(`/api/v1/offers/${oid}/accept`, { method: 'POST' }))}
                />
                <Attachments ownerType="lead" ownerId={id} />
                <Section title="История">
                  <ul>
                    {d.events.map((e) => (
                      <li key={e.id}>
                        {fmtDateTime(e.effectiveAt)} — {EVENT_LABELS[e.kind] ?? e.kind}
                        {e.newStage ? `: ${e.oldStage ? STAGE_LABELS[e.oldStage] : '∅'} → ${STAGE_LABELS[e.newStage]}` : ''}
                        {e.newOwnerId ? ` · ответственный: ${userName(e.oldOwnerId)} → ${userName(e.newOwnerId)}` : ''}
                        {e.reason ? <span className="muted"> ({e.reason})</span> : null}
                      </li>
                    ))}
                  </ul>
                </Section>
              </div>
              <div>
                {writable && (
                  <Section title="Изменить этап">
                    <StageChanger current={l.stage} onChange={(stage) => run(() => api(`/api/v1/leads/${id}/stage`, { method: 'PATCH', body: { version: l.version, stage } }))} />
                    {canDo(me, 'leads.reopen') && (l.stage === 'WON' || l.stage === 'LOST') && (
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={() => {
                          const reason = window.prompt('Причина повторного открытия');
                          if (reason) void run(() => api(`/api/v1/leads/${id}/reopen`, { method: 'POST', body: { reason } }));
                        }}
                      >
                        Открыть заново
                      </button>
                    )}
                  </Section>
                )}
                {canDo(me, 'leads.reassign') && (
                  <Section title="Сменить ответственного">
                    <select
                      aria-label="Новый ответственный"
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) void run(() => api(`/api/v1/leads/${id}/assignee`, { method: 'PATCH', body: { userId: e.target.value, reason: 'Решение администратора' } }));
                      }}
                    >
                      <option value="">Выберите…</option>
                      {team.data?.items.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.fullName}
                        </option>
                      ))}
                    </select>
                  </Section>
                )}
                <TourOperatorPicker current={d.tourOperator} ownedBy={d.operatorOwnedByOrder} readOnly={!writable} onSave={(tourOperatorId) => run(() => api(`/api/v1/leads/${id}`, { method: 'PATCH', body: { version: l.version, tourOperatorId } }))} />
                <Section title="Клиент">
                  {d.contact && editingContact ? (
                    <ContactEditForm
                      leadId={l.id}
                      contact={d.contact}
                      onCancel={() => setEditingContact(false)}
                      onSaved={() => {
                        setEditingContact(false);
                        void state.reload();
                      }}
                    />
                  ) : d.contact ? (
                    <>
                      <div>{d.contact.fullName && d.contact.fullName !== 'Instagram mijoz' ? d.contact.fullName : d.contact.instagramUsername ? `@${d.contact.instagramUsername}` : d.contact.fullName ?? '—'}</div>
                      <div className="muted">{d.contact.primaryPhone ?? 'Телефон не указан'}</div>
                      {d.contact.telegramUsername && (
                        <div className="muted">
                          Telegram:{' '}
                          <a href={`https://t.me/${encodeURIComponent(d.contact.telegramUsername)}`} target="_blank" rel="noopener noreferrer">
                            @{d.contact.telegramUsername}
                          </a>
                        </div>
                      )}
                      {l.note && <div className="muted">Заметка: {l.note}</div>}
                      {writable && (me.role === 'ADMIN' || l.ownerId === me.id) && (
                        <button className="btn secondary" type="button" onClick={() => setEditingContact(true)}>
                          Редактировать
                        </button>
                      )}
                      <Link href={`/contacts/${d.contact.id}`}>Карточка клиента и переписка</Link>
                    </>
                  ) : (
                    '—'
                  )}
                </Section>
                <Section title="Заказ">
                  {d.orders.length ? (
                    d.orders.map((o) => (
                      <div key={o.id}>
                        <Link href={`/orders/${o.id}`}>{o.orderNo}</Link> <Badge>{FULFILLMENT_LABELS[o.fulfillmentState] ?? o.fulfillmentState}</Badge>
                      </div>
                    ))
                  ) : writable ? (
                    <button className="btn" type="button" onClick={() => run(async () => router.push(`/orders/${(await api<{ id: string }>('/api/v1/orders', { method: 'POST', body: { leadId: id } })).id}`))}>
                      Создать заказ
                    </button>
                  ) : (
                    <span className="muted">Заказа пока нет</span>
                  )}
                </Section>
              </div>
            </div>
          </>
        );
      }}
    </Async>
  );
}

/** Туроператор (поставщик услуги). Это не рекламный источник: источник указан выше в поле «Источник». */
function TourOperatorPicker({ current, ownedBy, readOnly, onSave }: { current: LeadDetail['tourOperator']; ownedBy: LeadDetail['operatorOwnedByOrder']; readOnly: boolean; onSave: (id: string | null) => void }) {
  const list = useApi<{ items: Array<{ id: string; name: string; status: string }> }>('/api/v1/suppliers?status=active&kind=tour_operator');
  const options = list.data?.items ?? [];
  const all = current && !options.some((o) => o.id === current.id) ? [...options, current] : options;
  return (
    <Section title="Туроператор">
      <Field label="Туроператор-поставщик" hint="Не путайте с источником обращения клиента">
        <select value={current?.id ?? ''} onChange={(e) => onSave(e.target.value || null)} aria-label="Туроператор" disabled={!!ownedBy || readOnly}>
          <option value="">Не выбран</option>
          {all.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.status === 'archived' ? ' (архив)' : ''}
            </option>
          ))}
        </select>
      </Field>
      {ownedBy && (
        <p className="hint">
          Есть заказ <Link href={`/orders/${ownedBy.id}`}>{ownedBy.orderNo}</Link>: туроператор — историческая связь заказа. Меняйте его в карточке заказа (с причиной и записью в журнале); статистика прошлых продаж от изменений лида не зависит.
        </p>
      )}
    </Section>
  );
}

function StageChanger({ current, onChange }: { current: string; onChange: (s: string) => void }) {
  const [stage, setStage] = useState('');
  return (
    <div className="row">
      <select aria-label="Новый этап" value={stage} onChange={(e) => setStage(e.target.value)}>
        <option value="">Выберите…</option>
        {Object.entries(STAGE_LABELS)
          .filter(([k]) => k !== current)
          .map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
      </select>
      <button className="btn" type="button" disabled={!stage} onClick={() => onChange(stage)}>
        Применить
      </button>
    </div>
  );
}

function RequirementsForm({ lead, req, readOnly, onSave }: { lead: LeadDetail['lead']; req: Record<string, string | number | null>; readOnly: boolean; onSave: (body: Record<string, unknown>) => void }) {
  const [f, setF] = useState({
    serviceType: lead.serviceType ?? '',
    origin: String(req.origin ?? ''),
    destination: String(req.destination ?? ''),
    dateFrom: String(req.dateFrom ?? ''),
    dateTo: String(req.dateTo ?? ''),
    adults: String(req.adults ?? ''),
    children: String(req.children ?? ''),
    infants: String(req.infants ?? ''),
    budgetState: String(req.budgetState ?? ''),
    budgetAmount: String(req.budgetAmount ?? ''),
    budgetCurrency: String(req.budgetCurrency ?? 'USD'),
    contactOutcome: lead.contactOutcome ?? '',
    offerPrepDueAt: isoToTashkentLocal(lead.offerPrepDueAt),
    lostReasonCode: lead.lostReasonCode ?? '',
    nextContactAt: isoToTashkentLocal(lead.nextContactAt),
    followUpNote: lead.followUpNote ?? '',
    paymentDueAt: String(req.paymentDueAt ?? ''),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const num = (v: string) => (v === '' ? null : Number(v));
  const str = (v: string) => (v === '' ? null : v);
  return (
    <Section title="Пожелания клиента и рабочие поля">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            serviceType: str(f.serviceType),
            contactOutcome: str(f.contactOutcome),
            offerPrepDueAt: f.offerPrepDueAt ? tashkentLocalToIso(f.offerPrepDueAt) : null,
            lostReasonCode: str(f.lostReasonCode),
            nextContactAt: f.nextContactAt ? tashkentLocalToIso(f.nextContactAt) : null,
            followUpNote: str(f.followUpNote),
            requirements: {
              serviceType: str(f.serviceType),
              origin: str(f.origin),
              destination: str(f.destination),
              dateFrom: str(f.dateFrom),
              dateTo: str(f.dateTo),
              adults: num(f.adults),
              children: num(f.children),
              infants: num(f.infants),
              budgetState: str(f.budgetState),
              budgetAmount: str(f.budgetAmount),
              budgetCurrency: str(f.budgetCurrency),
              paymentDueAt: str(f.paymentDueAt),
            },
          });
        }}
      >
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="row">
            <Field label="Тип услуги">
              <select value={f.serviceType} onChange={set('serviceType')}>
                <option value="">—</option>
                <option value="avia">Авиабилеты</option>
                <option value="tour_package">Турпакет</option>
                <option value="hotel">Отель</option>
                <option value="transfer">Трансфер</option>
                <option value="visa">Виза</option>
                <option value="other">Другое</option>
              </select>
            </Field>
            <Field label="Откуда">
              <input value={f.origin} onChange={set('origin')} />
            </Field>
            <Field label="Куда">
              <input value={f.destination} onChange={set('destination')} />
            </Field>
          </div>
          <div className="row">
            <Field label="Вылет (с)">
              <IsoDateField value={f.dateFrom} onValue={(v) => set('dateFrom')({ target: { value: v } } as never)} />
            </Field>
            <Field label="Возвращение (по)">
              <IsoDateField value={f.dateTo} onValue={(v) => set('dateTo')({ target: { value: v } } as never)} />
            </Field>
            <Field label="Взрослые">
              <input type="number" min={0} value={f.adults} onChange={set('adults')} />
            </Field>
            <Field label="Дети">
              <input type="number" min={0} value={f.children} onChange={set('children')} />
            </Field>
            <Field label="Младенцы">
              <input type="number" min={0} value={f.infants} onChange={set('infants')} />
            </Field>
          </div>
          <div className="row">
            <Field label="Бюджет: статус">
              <select value={f.budgetState} onChange={set('budgetState')}>
                <option value="">—</option>
                <option value="known">Известен</option>
                <option value="undetermined">Не определён</option>
              </select>
            </Field>
            <Field label="Бюджет">
              <input value={f.budgetAmount} onChange={set('budgetAmount')} inputMode="decimal" />
            </Field>
            <Field label="Валюта">
              <select value={f.budgetCurrency} onChange={set('budgetCurrency')}>
                <option>USD</option>
                <option>UZS</option>
                <option>EUR</option>
              </select>
            </Field>
          </div>
          <div className="row">
            <Field label="Итог контакта">
              <input value={f.contactOutcome} onChange={set('contactOutcome')} />
            </Field>
            <Field label="Срок подготовки предложения">
              <LocalDateTimeField value={f.offerPrepDueAt} onValue={(v) => set('offerPrepDueAt')({ target: { value: v } } as never)} />
            </Field>
            <Field label="Срок оплаты">
              <IsoDateField value={f.paymentDueAt} onValue={(v) => set('paymentDueAt')({ target: { value: v } } as never)} />
            </Field>
          </div>
          <div className="row">
            <Field label="Время повторного контакта">
              <LocalDateTimeField value={f.nextContactAt} onValue={(v) => set('nextContactAt')({ target: { value: v } } as never)} />
            </Field>
            <Field label="Заметка к повторному контакту">
              <input value={f.followUpNote} onChange={set('followUpNote')} />
            </Field>
            <Field label="Причина отмены">
              <input value={f.lostReasonCode} onChange={set('lostReasonCode')} />
            </Field>
          </div>
          {!readOnly && (
            <button className="btn" type="submit">
              Сохранить
            </button>
          )}
        </fieldset>
      </form>
    </Section>
  );
}

function OffersSection({ offers, readOnly, onCreate, onSent, onAccept }: { offers: LeadDetail['offers']; readOnly: boolean; onCreate: (b: Record<string, unknown>) => void; onSent: (id: string) => void; onAccept: (id: string) => void }) {
  const [content, setContent] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  return (
    <Section title="Предложения (версии не изменяются)">
      {offers.map((o) => (
        <div key={o.id} className="card">
          <b>v{o.version}</b> — {o.amount} {o.currency} {o.sentAt ? <Badge tone="info">Отправлено {fmtDateTime(o.sentAt)}</Badge> : <Badge>Черновик</Badge>} {o.acceptedAt && <Badge tone="ok">Принято клиентом</Badge>}
          <p>{o.content}</p>
          {!readOnly && !o.sentAt && (
            <button className="btn small" type="button" onClick={() => onSent(o.id)}>
              Отметить как отправленное
            </button>
          )}
          {!readOnly && o.sentAt && !o.acceptedAt && (
            <button className="btn small" type="button" onClick={() => onAccept(o.id)}>
              Клиент подтвердил
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onCreate({ content, amount, currency });
            setContent('');
          }}
        >
          <Field label="Текст новой версии">
            <textarea value={content} onChange={(e) => setContent(e.target.value)} required />
          </Field>
          <div className="row">
            <Field label="Сумма">
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required pattern="\d+(\.\d{1,2})?" />
            </Field>
            <Field label="Валюта">
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option>USD</option>
                <option>UZS</option>
                <option>EUR</option>
              </select>
            </Field>
            <button className="btn" type="submit">
              Создать версию предложения
            </button>
          </div>
        </form>
      )}
    </Section>
  );
}
