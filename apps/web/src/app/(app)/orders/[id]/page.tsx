'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, CHECK_LABELS, fmtDateTime, newKey, OP_STATUS_LABELS, useApi, type ApiError } from '../../../../lib/api';
import { Async, Badge, Field, FormError, LocalDateTimeField, Section } from '../../../../components/ui';
import { Attachments, type DocOwner } from '../../../../components/attachments';
import { FinanceSummary, PricingForm, ServicesSection, SupplierRefundsSection, type FinanceView, type ServiceView, type SupplierRef, type SupplierRefundView } from '../../../../components/order-finance';
import { canWrite, useMe } from '../../../../components/shell';
import { FULFILLMENT_LABELS, OCCURRENCE_STATE_LABELS, PAYMENT_LABELS, SERVICE_TYPE_LABELS, TICKETING_LABELS } from '../../../../lib/format';

interface Segment {
  id: string;
  version: number;
  segmentNo: number;
  direction: string;
  originIata: string;
  destinationIata: string;
  marketingCarrier: string;
  flightNumber: string;
  departureAtUtc: string | null;
  departureTimezone: string;
  departureLocal: string | null;
  arrivalTimezone: string;
  arrivalLocal: string | null;
  pnr: string | null;
  operationalStatus: string;
  checkState: string;
  notificationState: string;
  scheduleRevision: number;
  lastCheckedAt: string | null;
  nextReminderAt: string | null;
  dataSource: string;
  liveData: boolean;
  checks: Array<{ id: string; result: string; milestone: string | null; scheduleRevision: number; checkedAt: string; note: string | null; source: string }>;
}
interface OrderView {
  order: {
    id: string;
    orderNo: string;
    version: number;
    agreedAmount: string | null;
    netPrice: string | null;
    tourOperatorId: string | null;
    currency: string | null;
    paymentState: string;
    ticketingState: string;
    fulfillmentState: string;
    saleEvidence: string | null;
    note: string | null;
    segments: Segment[];
    passengers: Array<{ id: string; fullName: string; type: string; tickets: Array<{ id: string; ticketNumber: string }> }>;
    payments: Array<{ id: string; kind: string; amount: string; currency: string; method: string; receivedAt: string }>;
    services: ServiceView[];
  };
  lead: { id: string; name: string; stage: string; version: number; serviceType: string | null; requirements: Record<string, unknown>; tourOperatorId: string | null } | null;
  contact: { id: string; fullName: string | null; primaryPhone: string | null; primaryEmail: string | null } | null;
  reminders: Array<{ id: string; kind: string; milestone: string | null; title: string; dueAt: string; state: string; scheduleRevision: number | null; escalatedAt: string | null }>;
  audit: Array<{ id: string; action: string; createdAt: string; actorType: string; oldValue: unknown; newValue: unknown }>;
  canCost: boolean;
  finance: FinanceView;
  supplierRefunds?: SupplierRefundView[];
  suppliers: Record<string, SupplierRef>;
  tourOperator: SupplierRef | null;
}

const DIRECTION_LABELS: Record<string, string> = { outbound: 'Туда', connection: 'Пересадка', return: 'Обратно' };
const PASSENGER_LABELS: Record<string, string> = { adult: 'Взрослый', child: 'Ребёнок', infant: 'Младенец' };
const METHOD_LABELS: Record<string, string> = { cash: 'Наличные', card: 'Карта', bank_transfer: 'Банковский перевод', online: 'Онлайн', other: 'Другое' };
const CHECK_RESULT_LABELS: Record<string, string> = { confirmed: 'Подтверждён', changed: 'Время изменилось', cancelled: 'Отменён' };
const ACTOR_TYPE_LABELS: Record<string, string> = { user: 'сотрудник', system: 'система', integration: 'интеграция' };

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const readOnly = !canWrite(me);
  const state = useApi<OrderView>(`/api/v1/orders/${id}`);
  const supplierList = useApi<{ items: SupplierRef[] }>('/api/v1/suppliers?status=active');
  const [error, setError] = useState<ApiError | null>(null);
  const [serviceError, setServiceError] = useState<ApiError | null>(null);
  const [refundError, setRefundError] = useState<ApiError | null>(null);
  const [operatorReason, setOperatorReason] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await state.reload();
      return true;
    } catch (e) {
      setError(e as ApiError);
      return false;
    }
  };
  const runService = async (fn: () => Promise<unknown>) => {
    setServiceError(null);
    try {
      await fn();
      await state.reload();
      return true;
    } catch (e) {
      setServiceError(e as ApiError);
      return false;
    }
  };

  return (
    <Async state={state}>
      {(d) => {
        const o = d.order;
        const cancelled = o.fulfillmentState === 'cancelled';
        const known = new Map<string, SupplierRef>();
        for (const s of supplierList.data?.items ?? []) known.set(s.id, s);
        for (const s of Object.values(d.suppliers)) known.set(s.id, s);
        const suppliers = [...known.values()];
        const operators = suppliers.filter((s) => s.kind === 'tour_operator' && (s.status === 'active' || s.id === o.tourOperatorId));
        const canCost = d.canCost;
        const docOwners: DocOwner[] = [
          { type: 'order', id, label: `Заказ ${o.orderNo}` },
          ...o.passengers.map((p) => ({ type: 'passenger' as const, id: p.id, label: `Пассажир: ${p.fullName}` })),
          ...(d.contact ? [{ type: 'contact' as const, id: d.contact.id, label: `Клиент: ${d.contact.fullName ?? '—'}` }] : []),
        ];
        return (
          <fieldset disabled={readOnly} className="ro">
            <h1>Заказ {o.orderNo}</h1>
            <p className="muted">
              Лид: {d.lead ? <Link href={`/leads/${d.lead.id}`}>{d.lead.name}</Link> : '—'} · Клиент: {d.contact ? <Link href={`/contacts/${d.contact.id}`}>{d.contact.fullName ?? '—'}</Link> : '—'}
            </p>
            <FormError error={error} />
            {cancelled && <div className="state denied">Заказ отменён: редактирование недоступно. Суммы сохраняются как история и не входят в итоговые продажи и прибыль.</div>}
            <Section title="Статусы (независимы друг от друга)">
              <div className="row">
                <StateSelect label="Исполнение" value={o.fulfillmentState} labels={FULFILLMENT_LABELS} options={['draft', 'confirmed', 'in_progress', 'completed', 'cancelled']} onChange={(v) => run(() => api(`/api/v1/orders/${id}`, { method: 'PATCH', body: { version: o.version, fulfillmentState: v } }))} />
                <StateSelect label="Билеты" value={o.ticketingState} labels={TICKETING_LABELS} options={['not_required', 'pending', 'reserved', 'issued', 'voided']} onChange={(v) => run(() => api(`/api/v1/orders/${id}`, { method: 'PATCH', body: { version: o.version, ticketingState: v } }))} />
                <StateSelect label="Оплата" value={o.paymentState} labels={PAYMENT_LABELS} options={['unpaid', 'partial', 'paid', 'refund_pending', 'refunded']} onChange={(v) => run(() => api(`/api/v1/orders/${id}`, { method: 'PATCH', body: { version: o.version, paymentState: v } }))} />
              </div>
            </Section>

            <Section title="Клиент и история общения">
              <CustomerHistory contact={d.contact} />
            </Section>

            <div className="split">
              <Section title="Пожелания по поездке">
                <TripRequirements lead={d.lead} />
              </Section>
              <Section title="Пассажиры">
                {o.passengers.map((p) => (
                  <div key={p.id}>
                    {p.fullName} <Badge>{PASSENGER_LABELS[p.type] ?? p.type}</Badge> {p.tickets.map((t) => <code key={t.id}> {t.ticketNumber}</code>)}
                  </div>
                ))}
                {!readOnly && <PassengerForm onAdd={(b) => run(() => api(`/api/v1/orders/${id}/passengers`, { method: 'POST', body: b }))} />}
              </Section>
            </div>

            <Section title="Турпакет, туроператор и цена">
              <div className="row">
                <Field label="Туроператор (поставщик)" hint="Историческая связь заказа: если туроператор лида позже изменится, статистика этой продажи не изменится. Это не рекламный источник. У заказов, созданных до миграции, значение восстановлено из выбора в лиде и исторически не подтверждено — администратору стоит проверить и при необходимости подтвердить с указанием причины.">
                  <select
                    value={o.tourOperatorId ?? ''}
                    disabled={cancelled}
                    onChange={(e) => run(() => api(`/api/v1/orders/${id}`, { method: 'PATCH', body: { version: o.version, tourOperatorId: e.target.value || null, ...(operatorReason.trim() ? { tourOperatorReason: operatorReason.trim() } : {}) } }).then(() => setOperatorReason('')))}
                  >
                    <option value="">Не выбран</option>
                    {operators.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.status === 'archived' ? ' (архив)' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Причина смены туроператора" hint="Обязательна для подтверждённого заказа; записывается в журнал">
                  <input value={operatorReason} onChange={(e) => setOperatorReason(e.target.value)} disabled={cancelled} placeholder="Например: клиент перешёл к другому оператору" />
                </Field>
                {d.tourOperator && (
                  <div className="field">
                    <span className="field-label">Выбран</span>
                    <span>
                      <b>{d.tourOperator.name}</b> {d.tourOperator.status === 'archived' && <Badge>Архив</Badge>}
                    </span>
                  </div>
                )}
              </div>
              <PricingForm key={o.version} order={o} canCost={canCost} disabled={cancelled} onSave={(b) => run(() => api(`/api/v1/orders/${id}`, { method: 'PATCH', body: { version: o.version, ...b } }))} />
            </Section>

            <FinanceSummary finance={d.finance} />

            <ServicesSection
              services={o.services}
              suppliers={suppliers}
              canCost={canCost}
              disabled={cancelled}
              error={serviceError}
              onAdd={(b) => runService(() => api(`/api/v1/orders/${id}/services`, { method: 'POST', body: b }))}
              onUpdate={(sid, b) => runService(() => api(`/api/v1/services/${sid}`, { method: 'PATCH', body: b }))}
              onRemove={(sid) => runService(() => api(`/api/v1/services/${sid}`, { method: 'DELETE' }))}
            />

            {canCost && (
              <SupplierRefundsSection
                refunds={d.supplierRefunds ?? []}
                suppliers={suppliers}
                defaultCurrency={o.currency}
                disabled={cancelled}
                error={refundError}
                onAdd={async (b) => {
                  setRefundError(null);
                  try {
                    await api(`/api/v1/orders/${id}/supplier-refunds`, { method: 'POST', body: b, idempotencyKey: newKey() });
                    await state.reload();
                    return true;
                  } catch (e) {
                    setRefundError(e as ApiError);
                    return false;
                  }
                }}
              />
            )}

            <Section title="Сегменты рейса">
              <p className="muted">Данные введены вручную (подключения к онлайн-данным о рейсах нет).</p>
              {o.segments.map((s) => (
                <SegmentCard key={s.id} s={s} run={run} />
              ))}
              {!readOnly && <AddSegment passengers={o.passengers} onAdd={async (b) => { await api(`/api/v1/orders/${id}/segments`, { method: 'POST', body: b }); await state.reload(); return true; }} />}
            </Section>

            <Section title="Платежи клиента и возвраты клиенту (запись не переводит деньги)">
              <table>
                <tbody>
                  {o.payments.map((p) => (
                    <tr key={p.id}>
                      <td>{fmtDateTime(p.receivedAt)}</td>
                      <td>{p.kind === 'refund' ? 'Возврат' : 'Платёж'}</td>
                      <td>
                        {p.amount} {p.currency}
                      </td>
                      <td>{METHOD_LABELS[p.method] ?? p.method}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">Возврат клиенту не может превышать оплаченную сумму, а его валюта должна совпадать с валютой заказа. Возврат не меняет первоначальную прибыль: он отдельно виден в «Прибыль после возвратов». Деньги, вернувшиеся от поставщика, записываются в отдельном разделе ниже.</p>
              {!readOnly && <PaymentForm onAdd={(b) => run(() => api(`/api/v1/orders/${id}/payments`, { method: 'POST', body: b, idempotencyKey: newKey() }))} />}
            </Section>

            <Attachments ownerType="order" ownerId={id} owners={docOwners} title="Документы" />

            <Section title="Заметки, задачи и напоминания">
              {o.note && (
                <p>
                  <b>Заметка:</b> {o.note}
                </p>
              )}
              <table>
                <thead>
                  <tr>
                    <th>Напоминание</th>
                    <th>Срок</th>
                    <th>Статус</th>
                    <th>Ревизия</th>
                  </tr>
                </thead>
                <tbody>
                  {d.reminders.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.title} {r.escalatedAt && <Badge tone="bad">Эскалация</Badge>}
                      </td>
                      <td>{fmtDateTime(r.dueAt)}</td>
                      <td>
                        <Badge tone={r.state === 'completed' ? 'ok' : r.state === 'due' ? 'warn' : r.state === 'missed' ? 'bad' : 'neutral'}>{OCCURRENCE_STATE_LABELS[r.state] ?? r.state}</Badge>
                      </td>
                      <td>{r.scheduleRevision ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!readOnly && <ManualReminder orderId={id} onAdd={(b) => run(() => api('/api/v1/reminders', { method: 'POST', body: b }))} />}
            </Section>

            <Section title="История изменений (журнал)">
              <ul>
                {d.audit.map((a) => (
                  <li key={a.id}>
                    {fmtDateTime(a.createdAt)} — {AUDIT_LABELS[a.action] ?? a.action} <span className="muted">({ACTOR_TYPE_LABELS[a.actorType] ?? a.actorType})</span>
                    {PRICE_ACTIONS.has(a.action) && <div className="muted audit-diff">{auditDiff(a.oldValue, a.newValue)}</div>}
                  </li>
                ))}
              </ul>
            </Section>
          </fieldset>
        );
      }}
    </Async>
  );
}

const PRICE_ACTIONS = new Set(['price_updated', 'service_price_updated', 'service_added', 'service_removed']);
const AUDIT_LABELS: Record<string, string> = {
  created: 'Заказ создан',
  price_updated: 'Цена изменена',
  service_price_updated: 'Цена услуги изменена',
  service_added: 'Услуга добавлена',
  service_removed: 'Услуга удалена',
  service_updated: 'Услуга изменена',
  passenger_added: 'Пассажир добавлен',
  ticket_added: 'Билет добавлен',
  tour_operator_changed: 'Туроператор изменён',
  supplier_refund_recorded: 'Возврат от поставщика записан',
  check_started: 'Проверка рейса начата',
  checked: 'Рейс проверен',
  customer_notified: 'Клиент уведомлён',
};

/** Показывает изменение цены в виде «было → стало» (значения из журнала на сервере). */
function auditDiff(oldV: unknown, newV: unknown): string {
  const pick = (v: unknown) => {
    const r = (v ?? {}) as Record<string, unknown>;
    const minor = (x: unknown) => (typeof x === 'string' && /^-?\d+$/.test(x) ? (Number(x) / 100).toFixed(2) : null);
    const parts = [
      ['продажа', r.amount ?? r.agreedAmount ?? minor(r.agreedAmountMinor)],
      ['себестоимость', r.netAmount ?? r.netPrice ?? minor(r.netPriceMinor)],
      ['валюта', r.currency],
    ].filter(([, x]) => x !== null && x !== undefined && x !== '');
    return parts.map(([k, x]) => `${k}: ${String(x)}`).join(', ') || '—';
  };
  return `${pick(oldV)} → ${pick(newV)}`;
}

function CustomerHistory({ contact }: { contact: OrderView['contact'] }) {
  const state = useApi<{ conversations: Array<{ messages: Array<{ id: string; direction: string; content: string | null; createdAt: string }> }> }>(contact ? `/api/v1/contacts/${contact.id}` : null);
  if (!contact) return <div className="state empty">Клиент не привязан</div>;
  const messages = (state.data?.conversations ?? [])
    .flatMap((c) => c.messages)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);
  return (
    <>
      <div>
        <b>{contact.fullName ?? '—'}</b> · {contact.primaryPhone ?? 'Телефон не указан'} {contact.primaryEmail ? `· ${contact.primaryEmail}` : ''}
      </div>
      {messages.length === 0 ? (
        <div className="muted">Переписки нет.</div>
      ) : (
        <ul className="msg-list">
          {messages.map((m) => (
            <li key={m.id}>
              <span className="muted">{fmtDateTime(m.createdAt)}</span> · {m.direction === 'inbound' ? 'Клиент' : 'Мы'}: {m.content ? m.content.slice(0, 140) : '—'}
            </li>
          ))}
        </ul>
      )}
      <Link href={`/contacts/${contact.id}`}>Полная история общения и карточка клиента</Link>
    </>
  );
}

function TripRequirements({ lead }: { lead: OrderView['lead'] }) {
  if (!lead) return <div className="state empty">Лид не найден</div>;
  const r = (lead.requirements ?? {}) as Record<string, string | number | null>;
  const rows: Array<[string, string | number | null | undefined]> = [
    ['Тип услуги', lead.serviceType ? (SERVICE_TYPE_LABELS[lead.serviceType] ?? lead.serviceType) : null],
    ['Откуда', r.origin],
    ['Куда', r.destination],
    ['Даты', r.dateFrom ? `${r.dateFrom}${r.dateTo ? ` → ${r.dateTo}` : ''}` : null],
    ['Взрослые / дети / младенцы', r.adults !== undefined || r.children !== undefined ? `${r.adults ?? 0} / ${r.children ?? 0} / ${r.infants ?? 0}` : null],
    ['Бюджет', r.budgetAmount ? `${r.budgetAmount} ${r.budgetCurrency ?? ''}` : r.budgetState === 'undetermined' ? 'не определён' : null],
  ];
  return (
    <>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v === null || v === undefined || v === '' ? '—' : String(v)}</dd>
          </div>
        ))}
      </dl>
      <p className="hint">
        Пожелания хранятся в карточке лида (один источник, без копий): <Link href={`/leads/${lead.id}`}>редактировать в карточке лида</Link>.
      </p>
    </>
  );
}

function StateSelect({ label, value, options, labels, onChange }: { label: string; value: string; options: string[]; labels: Record<string, string>; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {labels[o] ?? o}
          </option>
        ))}
      </select>
    </Field>
  );
}

function SegmentCard({ s, run }: { s: Segment; run: (fn: () => Promise<unknown>) => Promise<boolean> }) {
  const [result, setResult] = useState('confirmed');
  const [newLocal, setNewLocal] = useState('');
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(false);
  return (
    <div className="card">
      <div className="card-head">
        <h2>
          #{s.segmentNo} {s.originIata}–{s.destinationIata} · {s.marketingCarrier} {s.flightNumber} <Badge>{DIRECTION_LABELS[s.direction] ?? s.direction}</Badge>
        </h2>
        <div>
          <Badge tone={s.checkState === 'checked' ? 'ok' : s.checkState === 'due' || s.checkState === 'recheck_required' ? 'warn' : 'neutral'}>{CHECK_LABELS[s.checkState]}</Badge>{' '}
          {s.operationalStatus !== 'scheduled' && <Badge tone={s.operationalStatus === 'cancelled' ? 'bad' : 'warn'}>{OP_STATUS_LABELS[s.operationalStatus]}</Badge>}{' '}
          {s.notificationState === 'notified' && <Badge tone="ok">Клиент уведомлён</Badge>}
          {s.notificationState === 'required' && <Badge tone="warn">Нужно уведомить клиента</Badge>}
        </div>
      </div>
      <p>
        Вылет: <b>{s.departureLocal ? `${s.departureLocal.replace('T', ' ')} — время аэропорта, ${s.departureTimezone}` : 'не указан'}</b> · Ташкент: {fmtDateTime(s.departureAtUtc)} · PNR: {s.pnr ?? '—'} · Ревизия {s.scheduleRevision} · Последняя проверка: {fmtDateTime(s.lastCheckedAt)} · Следующее напоминание: {fmtDateTime(s.nextReminderAt)}
      </p>
      <div className="row">
        <button className="btn secondary" type="button" onClick={() => run(() => api(`/api/v1/segments/${s.id}/checks`, { method: 'POST', body: { action: 'start' } }))}>
          Начать проверку
        </button>
        <Field label="Результат">
          <select value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="confirmed">Подтверждён</option>
            <option value="changed">Время изменилось</option>
            <option value="cancelled">Отменён</option>
          </select>
        </Field>
        {result === 'changed' && (
          <Field label={`Новый вылет (${s.departureTimezone})`}>
            <LocalDateTimeField value={newLocal} onValue={setNewLocal} required />
          </Field>
        )}
        <Field label="Заметка">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <label>
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} style={{ width: 'auto' }} /> Нужно уведомить клиента
        </label>
        <button
          className="btn"
          type="button"
          onClick={() =>
            run(() =>
              api(`/api/v1/segments/${s.id}/checks`, {
                method: 'POST',
                body: { action: 'save', result, note: note || null, customerNotificationNeeded: notify, ...(result === 'changed' ? { observedDeparture: { local: newLocal, timezone: s.departureTimezone } } : {}) },
              }),
            )
          }
        >
          Сохранить результат
        </button>
        <button className="btn secondary" type="button" onClick={() => run(() => api(`/api/v1/segments/${s.id}/customer-notifications`, { method: 'POST', body: { channel: 'phone', result: 'reached' } }))}>
          Клиент уведомлён (по телефону)
        </button>
      </div>
      {s.checks.length > 0 && (
        <ul className="muted">
          {s.checks.map((c) => (
            <li key={c.id}>
              {fmtDateTime(c.checkedAt)} — {CHECK_RESULT_LABELS[c.result] ?? c.result} · {c.milestone ?? 'вручную'} · ревизия {c.scheduleRevision} · источник: {c.source === 'manual' ? 'вручную' : c.source} {c.note ? `· ${c.note}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ZONES = ['Asia/Tashkent', 'Europe/Istanbul', 'Asia/Dubai', 'Europe/Moscow', 'Asia/Bangkok', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Seoul', 'Europe/London'];

function AddSegment({ passengers, onAdd }: { passengers: OrderView['order']['passengers']; onAdd: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [f, setF] = useState({ direction: 'outbound', originIata: '', destinationIata: '', marketingCarrier: '', flightNumber: '', depLocal: '', depZone: 'Asia/Tashkent', arrLocal: '', arrZone: 'Asia/Tashkent', pnr: '' });
  const [offset, setOffset] = useState<number | null>(null);
  const [options, setOptions] = useState<Array<{ offsetMinutes: number; utc: string }> | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await onAdd({
          direction: f.direction,
          originIata: f.originIata.toUpperCase(),
          destinationIata: f.destinationIata.toUpperCase(),
          marketingCarrier: f.marketingCarrier.toUpperCase(),
          flightNumber: f.flightNumber,
          departure: f.depLocal ? { local: f.depLocal, timezone: f.depZone, confirmedOffsetMinutes: offset } : null,
          departureTimezone: f.depZone,
          arrival: f.arrLocal ? { local: f.arrLocal, timezone: f.arrZone } : null,
          arrivalTimezone: f.arrZone,
          pnr: f.pnr || null,
          passengerIds: passengers.map((p) => p.id),
        }).catch((err: ApiError) => {
          if (err.code === 'AMBIGUOUS_LOCAL_TIME') setOptions(err.details.options as Array<{ offsetMinutes: number; utc: string }>);
          setErr(err);
          return false;
        });
        if (ok) {
          setOptions(null);
          setErr(null);
        }
      }}
    >
      <h2>Добавить сегмент</h2>
      <div className="row">
        <Field label="Направление">
          <select value={f.direction} onChange={set('direction')}>
            <option value="outbound">Туда</option>
            <option value="connection">Пересадка</option>
            <option value="return">Обратно</option>
          </select>
        </Field>
        <Field label="Откуда (IATA)">
          <input value={f.originIata} onChange={set('originIata')} maxLength={3} required />
        </Field>
        <Field label="Куда (IATA)">
          <input value={f.destinationIata} onChange={set('destinationIata')} maxLength={3} required />
        </Field>
        <Field label="Авиакомпания">
          <input value={f.marketingCarrier} onChange={set('marketingCarrier')} maxLength={3} required />
        </Field>
        <Field label="Номер рейса">
          <input value={f.flightNumber} onChange={set('flightNumber')} required />
        </Field>
      </div>
      <div className="row">
        <Field label="Вылет (время аэропорта)">
          <LocalDateTimeField value={f.depLocal} onValue={(v) => set('depLocal')({ target: { value: v } })} />
        </Field>
        <Field label="Часовой пояс вылета (IANA)">
          <select value={f.depZone} onChange={set('depZone')}>
            {ZONES.map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </Field>
        <Field label="Прилёт (время аэропорта)">
          <LocalDateTimeField value={f.arrLocal} onValue={(v) => set('arrLocal')({ target: { value: v } })} />
        </Field>
        <Field label="Часовой пояс прилёта">
          <select value={f.arrZone} onChange={set('arrZone')}>
            {ZONES.map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </Field>
        <Field label="PNR">
          <input value={f.pnr} onChange={set('pnr')} />
        </Field>
      </div>
      {options && (
        <div className="state stale" role="alert">
          Это время встречается дважды из-за перехода на летнее/зимнее время. Выберите смещение:{' '}
          {options.map((o) => (
            <label key={o.offsetMinutes} style={{ marginRight: 12 }}>
              <input type="radio" name="offset" style={{ width: 'auto' }} checked={offset === o.offsetMinutes} onChange={() => setOffset(o.offsetMinutes)} /> UTC{o.offsetMinutes >= 0 ? '+' : ''}
              {o.offsetMinutes / 60}
            </label>
          ))}
        </div>
      )}
      <FormError error={err} />
      <button className="btn" type="submit">
        Сохранить сегмент
      </button>
    </form>
  );
}

function PaymentForm({ onAdd }: { onAdd: (b: Record<string, unknown>) => void }) {
  const [f, setF] = useState({ kind: 'payment', amount: '', currency: 'USD', method: 'cash', evidence: '' });
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd({ ...f, receivedAt: new Date().toISOString(), evidence: f.evidence || null });
      }}
    >
      <Field label="Тип">
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="payment">Платёж</option>
          <option value="refund">Возврат</option>
        </select>
      </Field>
      <Field label="Сумма">
        <input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} inputMode="decimal" required />
      </Field>
      <Field label="Валюта">
        <select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
          <option>USD</option>
          <option>UZS</option>
          <option>EUR</option>
        </select>
      </Field>
      <Field label="Способ">
        <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
          <option value="cash">Наличные</option>
          <option value="card">Карта</option>
          <option value="bank_transfer">Банковский перевод</option>
          <option value="online">Онлайн</option>
          <option value="other">Другое</option>
        </select>
      </Field>
      <Field label="Подтверждение">
        <input value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} />
      </Field>
      <button className="btn" type="submit">
        Записать
      </button>
    </form>
  );
}

function PassengerForm({ onAdd }: { onAdd: (b: Record<string, unknown>) => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('adult');
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd({ fullName: name, type });
        setName('');
      }}
    >
      <Field label="Имя и фамилия">
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Field label="Тип">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="adult">Взрослый</option>
          <option value="child">Ребёнок</option>
          <option value="infant">Младенец</option>
        </select>
      </Field>
      <button className="btn" type="submit">
        Добавить
      </button>
    </form>
  );
}

function ManualReminder({ orderId, onAdd }: { orderId: string; onAdd: (b: Record<string, unknown>) => void }) {
  const [f, setF] = useState({ title: '', localStart: '', timezone: 'Asia/Tashkent', kind: 'once', maxCount: '3' });
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd({ orderId, title: f.title, localStart: f.localStart, timezone: f.timezone, recurrence: f.kind === 'once' ? { kind: 'once' } : { kind: f.kind, maxCount: Number(f.maxCount) } });
      }}
    >
      <Field label="Своё напоминание">
        <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
      </Field>
      <Field label="Время">
        <LocalDateTimeField value={f.localStart} onValue={(v) => setF({ ...f, localStart: v })} required />
      </Field>
      <Field label="Часовой пояс">
        <select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
          {ZONES.map((z) => (
            <option key={z}>{z}</option>
          ))}
        </select>
      </Field>
      <Field label="Повтор">
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="once">Один раз</option>
          <option value="daily">Каждый день</option>
          <option value="weekly">Каждую неделю</option>
        </select>
      </Field>
      {f.kind !== 'once' && (
        <Field label="Максимум повторов">
          <input type="number" min={1} max={366} value={f.maxCount} onChange={(e) => setF({ ...f, maxCount: e.target.value })} required />
        </Field>
      )}
      <button className="btn" type="submit">
        Создать напоминание
      </button>
    </form>
  );
}
