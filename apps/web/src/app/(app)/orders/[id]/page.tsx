'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, CHECK_LABELS, fmtDateTime, newKey, OP_STATUS_LABELS, useApi, type ApiError } from '../../../../lib/api';
import { Async, Badge, Field, FormError, Section } from '../../../../components/ui';
import { Attachments, type DocOwner } from '../../../../components/attachments';
import { FinanceSummary, PricingForm, ServicesSection, SupplierRefundsSection, type FinanceView, type ServiceView, type SupplierRef, type SupplierRefundView } from '../../../../components/order-finance';
import { SERVICE_TYPE_LABELS } from '../../../../lib/format';

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

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
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
          { type: 'order', id, label: `Buyurtma ${o.orderNo}` },
          ...o.passengers.map((p) => ({ type: 'passenger' as const, id: p.id, label: `Yo‘lovchi: ${p.fullName}` })),
          ...(d.contact ? [{ type: 'contact' as const, id: d.contact.id, label: `Mijoz: ${d.contact.fullName ?? '—'}` }] : []),
        ];
        return (
          <>
            <h1>Buyurtma {o.orderNo}</h1>
            <p className="muted">
              Lid: {d.lead ? <Link href={`/leads/${d.lead.id}`}>{d.lead.name}</Link> : '—'} · Mijoz: {d.contact ? <Link href={`/contacts/${d.contact.id}`}>{d.contact.fullName ?? '—'}</Link> : '—'}
            </p>
            <FormError error={error} />
            {cancelled && <div className="state denied">Buyurtma bekor qilingan: tahrirlab bo‘lmaydi. Summalar tarix sifatida saqlanadi va jami sotuv/foydaga kirmaydi.</div>}
            <Section title="Holatlar (bir-biridan mustaqil)">
              <div className="row">
                <StateSelect label="Xizmat" value={o.fulfillmentState} options={['draft', 'confirmed', 'in_progress', 'completed', 'cancelled']} onChange={(v) => run(() => api(`/api/v1/orders/${id}`, { method: 'PATCH', body: { version: o.version, fulfillmentState: v } }))} />
                <StateSelect label="Chipta" value={o.ticketingState} options={['not_required', 'pending', 'reserved', 'issued', 'voided']} onChange={(v) => run(() => api(`/api/v1/orders/${id}`, { method: 'PATCH', body: { version: o.version, ticketingState: v } }))} />
                <StateSelect label="To‘lov" value={o.paymentState} options={['unpaid', 'partial', 'paid', 'refund_pending', 'refunded']} onChange={(v) => run(() => api(`/api/v1/orders/${id}`, { method: 'PATCH', body: { version: o.version, paymentState: v } }))} />
              </div>
            </Section>

            <Section title="Mijoz va aloqa tarixi">
              <CustomerHistory contact={d.contact} />
            </Section>

            <div className="split">
              <Section title="Safar talablari">
                <TripRequirements lead={d.lead} />
              </Section>
              <Section title="Yo‘lovchilar">
                {o.passengers.map((p) => (
                  <div key={p.id}>
                    {p.fullName} <Badge>{p.type}</Badge> {p.tickets.map((t) => <code key={t.id}> {t.ticketNumber}</code>)}
                  </div>
                ))}
                <PassengerForm onAdd={(b) => run(() => api(`/api/v1/orders/${id}/passengers`, { method: 'POST', body: b }))} />
              </Section>
            </div>

            <Section title="Turpaket, turoperator va narx">
              <div className="row">
                <Field label="Turoperator (yetkazib beruvchi)" hint="Buyurtmaning tarixiy bog‘lanishi: lid operatori keyin o‘zgarsa ham bu sotuv statistikasi o‘zgarmaydi. Reklama manbasi emas. Migratsiyadan oldingi buyurtmalarda bu qiymat lid tanlovidan tiklangan va tarixiy tasdiqlanmagan — rahbar tekshirib, kerak bo‘lsa sabab bilan tasdiqlasin.">
                  <select
                    value={o.tourOperatorId ?? ''}
                    disabled={cancelled}
                    onChange={(e) => run(() => api(`/api/v1/orders/${id}`, { method: 'PATCH', body: { version: o.version, tourOperatorId: e.target.value || null, ...(operatorReason.trim() ? { tourOperatorReason: operatorReason.trim() } : {}) } }).then(() => setOperatorReason('')))}
                  >
                    <option value="">Tanlanmagan</option>
                    {operators.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.status === 'archived' ? ' (arxiv)' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Operator o‘zgartirish sababi" hint="Tasdiqlangan buyurtmada majburiy; auditga yoziladi">
                  <input value={operatorReason} onChange={(e) => setOperatorReason(e.target.value)} disabled={cancelled} placeholder="Masalan: mijoz boshqa operatorga o‘tdi" />
                </Field>
                {d.tourOperator && (
                  <div className="field">
                    <span className="field-label">Tanlangan</span>
                    <span>
                      <b>{d.tourOperator.name}</b> {d.tourOperator.status === 'archived' && <Badge>Arxiv</Badge>}
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

            <Section title="Reys segmentlari">
              <p className="muted">Ma’lumot manbasi: qo‘lda kiritilgan (manual). Bu jonli reys API ma’lumoti emas.</p>
              {o.segments.map((s) => (
                <SegmentCard key={s.id} s={s} run={run} />
              ))}
              <AddSegment passengers={o.passengers} onAdd={async (b) => { await api(`/api/v1/orders/${id}/segments`, { method: 'POST', body: b }); await state.reload(); return true; }} />
            </Section>

            <Section title="Mijoz to‘lovlari va mijozga qaytarimlar (qayd etish pul o‘tkazmaydi)">
              <table>
                <tbody>
                  {o.payments.map((p) => (
                    <tr key={p.id}>
                      <td>{fmtDateTime(p.receivedAt)}</td>
                      <td>{p.kind === 'refund' ? 'Qaytarim' : 'To‘lov'}</td>
                      <td>
                        {p.amount} {p.currency}
                      </td>
                      <td>{p.method}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">Mijozga qaytarim to‘langan summadan oshmasligi va valyutasi buyurtma valyutasiga mos bo‘lishi shart. Dastlabki foydani o‘zgartirmaydi: u «Qaytarimdan keyingi foyda»da alohida ko‘rinadi. Yetkazib beruvchidan qaytgan summa pastdagi alohida bo‘limda qayd etiladi.</p>
              <PaymentForm onAdd={(b) => run(() => api(`/api/v1/orders/${id}/payments`, { method: 'POST', body: b, idempotencyKey: newKey() }))} />
            </Section>

            <Attachments ownerType="order" ownerId={id} owners={docOwners} title="Hujjatlar" />

            <Section title="Izohlar, vazifalar va eslatmalar">
              {o.note && (
                <p>
                  <b>Izoh:</b> {o.note}
                </p>
              )}
              <table>
                <thead>
                  <tr>
                    <th>Eslatma</th>
                    <th>Vaqt</th>
                    <th>Holat</th>
                    <th>Revision</th>
                  </tr>
                </thead>
                <tbody>
                  {d.reminders.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.title} {r.escalatedAt && <Badge tone="bad">Eskalatsiya</Badge>}
                      </td>
                      <td>{fmtDateTime(r.dueAt)}</td>
                      <td>
                        <Badge tone={r.state === 'completed' ? 'ok' : r.state === 'due' ? 'warn' : r.state === 'missed' ? 'bad' : 'neutral'}>{r.state}</Badge>
                      </td>
                      <td>{r.scheduleRevision ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ManualReminder orderId={id} onAdd={(b) => run(() => api('/api/v1/reminders', { method: 'POST', body: b }))} />
            </Section>

            <Section title="O‘zgarishlar tarixi (audit)">
              <ul>
                {d.audit.map((a) => (
                  <li key={a.id}>
                    {fmtDateTime(a.createdAt)} — {AUDIT_LABELS[a.action] ?? a.action} <span className="muted">({a.actorType})</span>
                    {PRICE_ACTIONS.has(a.action) && <div className="muted audit-diff">{auditDiff(a.oldValue, a.newValue)}</div>}
                  </li>
                ))}
              </ul>
            </Section>
          </>
        );
      }}
    </Async>
  );
}

const PRICE_ACTIONS = new Set(['price_updated', 'service_price_updated', 'service_added', 'service_removed']);
const AUDIT_LABELS: Record<string, string> = {
  price_updated: 'Narx o‘zgardi',
  service_price_updated: 'Xizmat narxi o‘zgardi',
  service_added: 'Xizmat qo‘shildi',
  service_removed: 'Xizmat olib tashlandi',
  service_updated: 'Xizmat o‘zgardi',
};

/** Narx o'zgarishini eski → yangi ko'rinishida qisqa ko'rsatadi (backend auditidagi qiymatlar). */
function auditDiff(oldV: unknown, newV: unknown): string {
  const pick = (v: unknown) => {
    const r = (v ?? {}) as Record<string, unknown>;
    const minor = (x: unknown) => (typeof x === 'string' && /^-?\d+$/.test(x) ? (Number(x) / 100).toFixed(2) : null);
    const parts = [
      ['sotuv', r.amount ?? r.agreedAmount ?? minor(r.agreedAmountMinor)],
      ['tannarx', r.netAmount ?? r.netPrice ?? minor(r.netPriceMinor)],
      ['valyuta', r.currency],
    ].filter(([, x]) => x !== null && x !== undefined && x !== '');
    return parts.map(([k, x]) => `${k}: ${String(x)}`).join(', ') || '—';
  };
  return `${pick(oldV)} → ${pick(newV)}`;
}

function CustomerHistory({ contact }: { contact: OrderView['contact'] }) {
  const state = useApi<{ conversations: Array<{ messages: Array<{ id: string; direction: string; content: string | null; createdAt: string }> }> }>(contact ? `/api/v1/contacts/${contact.id}` : null);
  if (!contact) return <div className="state empty">Mijoz biriktirilmagan</div>;
  const messages = (state.data?.conversations ?? [])
    .flatMap((c) => c.messages)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);
  return (
    <>
      <div>
        <b>{contact.fullName ?? '—'}</b> · {contact.primaryPhone ?? 'Telefon yo‘q'} {contact.primaryEmail ? `· ${contact.primaryEmail}` : ''}
      </div>
      {messages.length === 0 ? (
        <div className="muted">Yozishmalar yo‘q.</div>
      ) : (
        <ul className="msg-list">
          {messages.map((m) => (
            <li key={m.id}>
              <span className="muted">{fmtDateTime(m.createdAt)}</span> · {m.direction === 'inbound' ? 'Mijoz' : 'Biz'}: {m.content ? m.content.slice(0, 140) : '—'}
            </li>
          ))}
        </ul>
      )}
      <Link href={`/contacts/${contact.id}`}>To‘liq aloqa tarixi va mijoz kartasi</Link>
    </>
  );
}

function TripRequirements({ lead }: { lead: OrderView['lead'] }) {
  if (!lead) return <div className="state empty">Lid topilmadi</div>;
  const r = (lead.requirements ?? {}) as Record<string, string | number | null>;
  const rows: Array<[string, string | number | null | undefined]> = [
    ['Xizmat turi', lead.serviceType ? (SERVICE_TYPE_LABELS[lead.serviceType] ?? lead.serviceType) : null],
    ['Qayerdan', r.origin],
    ['Qayerga', r.destination],
    ['Sanalar', r.dateFrom ? `${r.dateFrom}${r.dateTo ? ` → ${r.dateTo}` : ''}` : null],
    ['Kattalar / bolalar / chaqaloqlar', r.adults !== undefined || r.children !== undefined ? `${r.adults ?? 0} / ${r.children ?? 0} / ${r.infants ?? 0}` : null],
    ['Byudjet', r.budgetAmount ? `${r.budgetAmount} ${r.budgetCurrency ?? ''}` : r.budgetState === 'undetermined' ? 'aniqlanmagan' : null],
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
        Talablar lid kartasida saqlanadi (bitta manba, nusxa yo‘q): <Link href={`/leads/${lead.id}`}>lid kartasida tahrirlash</Link>.
      </p>
    </>
  );
}

function StateSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o}>{o}</option>
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
          #{s.segmentNo} {s.originIata}–{s.destinationIata} · {s.marketingCarrier} {s.flightNumber} <Badge>{s.direction}</Badge>
        </h2>
        <div>
          <Badge tone={s.checkState === 'checked' ? 'ok' : s.checkState === 'due' || s.checkState === 'recheck_required' ? 'warn' : 'neutral'}>{CHECK_LABELS[s.checkState]}</Badge>{' '}
          {s.operationalStatus !== 'scheduled' && <Badge tone={s.operationalStatus === 'cancelled' ? 'bad' : 'warn'}>{OP_STATUS_LABELS[s.operationalStatus]}</Badge>}{' '}
          {s.notificationState === 'notified' && <Badge tone="ok">Mijoz xabardor qilindi</Badge>}
          {s.notificationState === 'required' && <Badge tone="warn">Mijozni xabardor qilish kerak</Badge>}
        </div>
      </div>
      <p>
        Jo‘nash: <b>{s.departureLocal ? `${s.departureLocal.replace('T', ' ')} — aeroport vaqti, ${s.departureTimezone}` : 'kiritilmagan'}</b> · Toshkent: {fmtDateTime(s.departureAtUtc)} · PNR: {s.pnr ?? '—'} · Revision {s.scheduleRevision} · Oxirgi tekshiruv: {fmtDateTime(s.lastCheckedAt)} · Keyingi eslatma: {fmtDateTime(s.nextReminderAt)}
      </p>
      <div className="row">
        <button className="btn secondary" type="button" onClick={() => run(() => api(`/api/v1/segments/${s.id}/checks`, { method: 'POST', body: { action: 'start' } }))}>
          Tekshirishni boshlash
        </button>
        <Field label="Natija">
          <select value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="confirmed">Tasdiqlandi</option>
            <option value="changed">Vaqt o‘zgargan</option>
            <option value="cancelled">Bekor qilingan</option>
          </select>
        </Field>
        {result === 'changed' && (
          <Field label={`Yangi jo‘nash (${s.departureTimezone})`}>
            <input type="datetime-local" value={newLocal} onChange={(e) => setNewLocal(e.target.value)} required />
          </Field>
        )}
        <Field label="Izoh">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <label>
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} style={{ width: 'auto' }} /> Mijozga xabar kerak
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
          Natijani saqlash
        </button>
        <button className="btn secondary" type="button" onClick={() => run(() => api(`/api/v1/segments/${s.id}/customer-notifications`, { method: 'POST', body: { channel: 'phone', result: 'reached' } }))}>
          Mijoz xabardor qilindi (telefon)
        </button>
      </div>
      {s.checks.length > 0 && (
        <ul className="muted">
          {s.checks.map((c) => (
            <li key={c.id}>
              {fmtDateTime(c.checkedAt)} — {c.result} · {c.milestone ?? 'qo‘lda'} · rev {c.scheduleRevision} · manba: {c.source} {c.note ? `· ${c.note}` : ''}
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
      <h2>Segment qo‘shish</h2>
      <div className="row">
        <Field label="Yo‘nalish">
          <select value={f.direction} onChange={set('direction')}>
            <option value="outbound">Borish</option>
            <option value="connection">Ulanish</option>
            <option value="return">Qaytish</option>
          </select>
        </Field>
        <Field label="Qayerdan (IATA)">
          <input value={f.originIata} onChange={set('originIata')} maxLength={3} required />
        </Field>
        <Field label="Qayerga (IATA)">
          <input value={f.destinationIata} onChange={set('destinationIata')} maxLength={3} required />
        </Field>
        <Field label="Aviakompaniya">
          <input value={f.marketingCarrier} onChange={set('marketingCarrier')} maxLength={3} required />
        </Field>
        <Field label="Reys raqami">
          <input value={f.flightNumber} onChange={set('flightNumber')} required />
        </Field>
      </div>
      <div className="row">
        <Field label="Jo‘nash (aeroport vaqti)">
          <input type="datetime-local" value={f.depLocal} onChange={set('depLocal')} />
        </Field>
        <Field label="Jo‘nash zonasi (IANA)">
          <select value={f.depZone} onChange={set('depZone')}>
            {ZONES.map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </Field>
        <Field label="Yetib kelish (aeroport vaqti)">
          <input type="datetime-local" value={f.arrLocal} onChange={set('arrLocal')} />
        </Field>
        <Field label="Yetib kelish zonasi">
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
          Bu vaqt DST sababli ikki marta uchraydi. Offsetni tanlang:{' '}
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
        Segmentni saqlash
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
      <Field label="Turi">
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="payment">To‘lov</option>
          <option value="refund">Qaytarim</option>
        </select>
      </Field>
      <Field label="Summa">
        <input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} inputMode="decimal" required />
      </Field>
      <Field label="Valyuta">
        <select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
          <option>USD</option>
          <option>UZS</option>
          <option>EUR</option>
        </select>
      </Field>
      <Field label="Usul">
        <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
          <option value="cash">Naqd</option>
          <option value="card">Karta</option>
          <option value="bank_transfer">Bank o‘tkazmasi</option>
          <option value="online">Onlayn</option>
          <option value="other">Boshqa</option>
        </select>
      </Field>
      <Field label="Dalil">
        <input value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} />
      </Field>
      <button className="btn" type="submit">
        Qayd etish
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
      <Field label="F.I.Sh.">
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Field label="Turi">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="adult">Katta</option>
          <option value="child">Bola</option>
          <option value="infant">Chaqaloq</option>
        </select>
      </Field>
      <button className="btn" type="submit">
        Qo‘shish
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
      <Field label="Qo‘lda eslatma">
        <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
      </Field>
      <Field label="Vaqt">
        <input type="datetime-local" value={f.localStart} onChange={(e) => setF({ ...f, localStart: e.target.value })} required />
      </Field>
      <Field label="Zona">
        <select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
          {ZONES.map((z) => (
            <option key={z}>{z}</option>
          ))}
        </select>
      </Field>
      <Field label="Takrorlanish">
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="once">Bir marta</option>
          <option value="daily">Har kuni</option>
          <option value="weekly">Har hafta</option>
        </select>
      </Field>
      {f.kind !== 'once' && (
        <Field label="Maksimal son">
          <input type="number" min={1} max={366} value={f.maxCount} onChange={(e) => setF({ ...f, maxCount: e.target.value })} required />
        </Field>
      )}
      <button className="btn" type="submit">
        Eslatma yaratish
      </button>
    </form>
  );
}
