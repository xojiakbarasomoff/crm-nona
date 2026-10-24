'use client';

import { useState } from 'react';
import type { ApiError } from '../lib/api';
import { CURRENCIES, fmtMoney, MEAL_PLANS, profitPreview, SERVICE_TYPE_LABELS, SUPPLIER_KIND_LABELS } from '../lib/format';
import { Badge, Field, FormError, Section } from './ui';

export interface FinanceView {
  hasPrice: boolean;
  profitUndetermined: boolean;
  byCurrency: Record<string, { selling: string; net: string | null; netComplete: boolean; profit: string | null; profitState: 'known' | 'undetermined'; marginPercent: string | null; lines: number; missingNetLines: number }>;
  formula: string;
}

export interface ServiceView {
  id: string;
  serviceType: string;
  description: string;
  amount: string | null;
  netAmount: string | null;
  currency: string | null;
  profit: string | null;
  supplierId: string | null;
  includedInPackage: boolean;
  details: Record<string, unknown>;
}

export interface SupplierRef {
  id: string;
  name: string;
  kind: string;
  status: string;
}

const isNeg = (v: string | null) => !!v && v.startsWith('-');

/** Foyda: avtomatik, qo'lda tahrirlanmaydi. Tannarx yo'q bo'lsa «Aniqlanmagan» (0 emas). */
export function ProfitCell({ profit, currency }: { profit: string | null; currency: string }) {
  if (profit === null) return <Badge tone="warn">Aniqlanmagan</Badge>;
  return <b className={isNeg(profit) ? 'neg' : 'pos'}>{fmtMoney(profit, currency)}</b>;
}

export function FinanceSummary({ finance }: { finance: FinanceView }) {
  const rows = Object.entries(finance.byCurrency);
  return (
    <Section title="Foyda hisobi (valyutalar alohida)">
      {rows.length === 0 ? (
        <div className="state empty">Narx hali kiritilmagan. Sotuv narxi va tannarxni kiriting — foyda avtomatik hisoblanadi.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Valyuta</th>
                <th>Sotuv narxi</th>
                <th>Tannarx</th>
                <th>Foyda</th>
                <th>Marja</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([ccy, r]) => (
                <tr key={ccy}>
                  <td>{ccy}</td>
                  <td>{fmtMoney(r.selling, ccy)}</td>
                  <td>
                    {r.net === null ? <span className="muted">kiritilmagan</span> : fmtMoney(r.net, ccy)}
                    {r.net !== null && !r.netComplete && <div className="muted">qisman ({r.missingNetLines} qatorda yo‘q)</div>}
                  </td>
                  <td>
                    <ProfitCell profit={r.profit} currency={ccy} />
                    {r.profit === null && <div className="muted">Tannarx to‘liq emas — 0 deb hisoblanmaydi</div>}
                  </td>
                  <td>{r.marginPercent === null ? '—' : `${r.marginPercent.replace('.', ',')}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">
        <b>Foyda = sotuv narxi − tannarx.</b> Foyda avtomatik hisoblanadi va qo‘lda tahrirlanmaydi; manfiy bo‘lishi mumkin. Qo‘shimcha xarajatlar (komissiya, soliq, bank to‘lovlari, valyuta farqi) hisobga olinmagan, shuning uchun bu buxgalteriya bo‘yicha yakuniy «sof foyda» emas. Turpaket narxi va uning ichiga kiritilgan xizmatlar ikki marta sanalmaydi.
      </p>
    </Section>
  );
}

export interface PricingOrder {
  agreedAmount: string | null;
  netPrice: string | null;
  currency: string | null;
  saleEvidence: string | null;
  note: string | null;
}

/** Turpaket darajasidagi narx: sotuv narxi (selling), tannarx (net), valyuta, dalil va izoh. */
export function PricingForm({ order, disabled, onSave }: { order: PricingOrder; disabled?: boolean; onSave: (b: Record<string, unknown>) => void }) {
  const [amount, setAmount] = useState(order.agreedAmount ?? '');
  const [net, setNet] = useState(order.netPrice ?? '');
  const [currency, setCurrency] = useState(order.currency ?? 'USD');
  const [evidence, setEvidence] = useState(order.saleEvidence ?? '');
  const [note, setNote] = useState(order.note ?? '');
  const preview = amount && net ? profitPreview(amount, net) : null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const hasPricing = !!amount || !!net || !!order.currency;
        onSave({
          saleEvidence: evidence || null,
          note: note || null,
          ...(hasPricing ? { currency, ...(amount ? { agreedAmount: amount } : {}), netPrice: net || null } : {}),
        });
      }}
    >
      <div className="row">
        <Field label="Sotuv narxi (mijozga, selling price)">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="1200.00" disabled={disabled} />
        </Field>
        <Field label="Tannarx (turoperatordan, net price)" hint="Bo‘sh = noma’lum (0 emas)">
          <input value={net} onChange={(e) => setNet(e.target.value)} inputMode="decimal" placeholder="1000.00" disabled={disabled} />
        </Field>
        <Field label="Valyuta">
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={disabled}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <div className="field profit-preview" aria-live="polite">
          <span className="field-label">Foyda (avtomatik)</span>
          {preview === null ? <span className="muted">{amount ? 'tannarx kiriting' : '—'}</span> : <b className={isNeg(preview) ? 'neg' : 'pos'}>{fmtMoney(preview, currency)}</b>}
        </div>
      </div>
      <div className="row">
        <Field label="Sotuv tasdiqlash dalili">
          <input value={evidence} onChange={(e) => setEvidence(e.target.value)} disabled={disabled} />
        </Field>
        <Field label="Buyurtma qaydi">
          <input value={note} onChange={(e) => setNote(e.target.value)} disabled={disabled} />
        </Field>
        <button className="btn" type="submit" disabled={disabled}>
          Saqlash
        </button>
      </div>
    </form>
  );
}

const str = (v: string) => (v.trim() === '' ? null : v.trim());
const detailText = (s: ServiceView) => {
  const d = s.details as Record<string, string | null | undefined>;
  if (s.serviceType === 'hotel') return [d.hotelName, d.address, d.checkIn && d.checkOut ? `${d.checkIn} → ${d.checkOut}` : null, d.roomType, d.mealPlan].filter(Boolean).join(' · ');
  if (s.serviceType === 'transfer') return [d.route, d.pickupAt ? d.pickupAt.replace('T', ' ') : null, d.vehicle].filter(Boolean).join(' · ');
  return '';
};

export function ServicesSection({
  services,
  suppliers,
  disabled,
  onAdd,
  onUpdate,
  onRemove,
  error,
}: {
  services: ServiceView[];
  suppliers: SupplierRef[];
  disabled?: boolean;
  onAdd: (body: Record<string, unknown>) => Promise<boolean>;
  onUpdate: (id: string, body: Record<string, unknown>) => Promise<boolean>;
  onRemove: (id: string) => Promise<boolean>;
  error: ApiError | null;
}) {
  const [editing, setEditing] = useState<ServiceView | null>(null);
  const nameOf = (id: string | null) => suppliers.find((s) => s.id === id)?.name ?? (id ? '—' : '');
  return (
    <Section title="Xizmatlar: mehmonxona, transfer, avia va boshqalar">
      <p className="muted">
        Har bir xizmat qatorida sotuv narxi, tannarx va yetkazib beruvchi alohida bo‘lishi mumkin. Jami qiymat turpaket narxi + paketdan <b>tashqari</b> xizmatlar yig‘indisi; «paketga kiritilgan» xizmat jamiga qo‘shilmaydi (ikki marta sanalmasin). Reyslar «Reys segmentlari» bo‘limida.
      </p>
      {services.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tur</th>
                <th>Tavsif va tafsilot</th>
                <th>Yetkazib beruvchi</th>
                <th>Sotuv</th>
                <th>Tannarx</th>
                <th>Foyda</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.id} className={s.includedInPackage ? 'row-included' : ''}>
                  <td>{SERVICE_TYPE_LABELS[s.serviceType] ?? s.serviceType}</td>
                  <td>
                    {s.description}
                    <div className="muted">{detailText(s)}</div>
                    {s.includedInPackage && <Badge tone="info">Paketga kiritilgan — jamiga qo‘shilmaydi</Badge>}
                  </td>
                  <td>{nameOf(s.supplierId) || '—'}</td>
                  <td>{fmtMoney(s.amount, s.currency)}</td>
                  <td>{s.netAmount === null ? <span className="muted">—</span> : fmtMoney(s.netAmount, s.currency)}</td>
                  <td>{s.profit === null ? <span className="muted">—</span> : <b className={isNeg(s.profit) ? 'neg' : 'pos'}>{fmtMoney(s.profit, s.currency)}</b>}</td>
                  <td>
                    <button type="button" className="btn small secondary" disabled={disabled} onClick={() => setEditing(s)}>
                      Tahrirlash
                    </button>
                    <button
                      type="button"
                      className="btn small secondary"
                      disabled={disabled}
                      onClick={async () => {
                        if (window.confirm(`«${s.description}» xizmati olib tashlansinmi? Tarix auditda saqlanadi.`)) await onRemove(s.id);
                      }}
                    >
                      Olib tashlash
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ServiceForm
        key={editing?.id ?? 'new'}
        initial={editing}
        suppliers={suppliers}
        disabled={disabled}
        error={error}
        onCancel={editing ? () => setEditing(null) : undefined}
        onSubmit={async (body) => {
          const ok = editing ? await onUpdate(editing.id, body) : await onAdd(body);
          if (ok) setEditing(null);
          return ok;
        }}
      />
    </Section>
  );
}

function ServiceForm({
  initial,
  suppliers,
  disabled,
  error,
  onSubmit,
  onCancel,
}: {
  initial: ServiceView | null;
  suppliers: SupplierRef[];
  disabled?: boolean;
  error: ApiError | null;
  onSubmit: (b: Record<string, unknown>) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const d = (initial?.details ?? {}) as Record<string, string | null | undefined>;
  const [f, setF] = useState({
    serviceType: initial?.serviceType ?? 'hotel',
    description: initial?.description ?? '',
    amount: initial?.amount ?? '',
    netAmount: initial?.netAmount ?? '',
    currency: initial?.currency ?? 'USD',
    supplierId: initial?.supplierId ?? '',
    includedInPackage: initial?.includedInPackage ?? false,
    hotelName: d.hotelName ?? '',
    address: d.address ?? '',
    checkIn: d.checkIn ?? '',
    checkOut: d.checkOut ?? '',
    roomType: d.roomType ?? '',
    mealPlan: d.mealPlan ?? '',
    route: d.route ?? '',
    pickupAt: d.pickupAt ?? '',
    vehicle: d.vehicle ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const selectable = suppliers.filter((s) => s.status === 'active' || s.id === initial?.supplierId);
  const preview = f.amount && f.netAmount ? profitPreview(f.amount, f.netAmount) : null;
  return (
    <form
      className="card service-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const details = f.serviceType === 'hotel' ? { hotelName: f.hotelName, address: str(f.address), checkIn: f.checkIn, checkOut: f.checkOut, roomType: str(f.roomType), mealPlan: str(f.mealPlan) } : f.serviceType === 'transfer' ? { route: f.route, pickupAt: f.pickupAt, vehicle: str(f.vehicle) } : {};
        const priced = !!f.amount || !!f.netAmount;
        const ok = await onSubmit({
          serviceType: f.serviceType,
          description: f.description,
          amount: str(f.amount),
          netAmount: str(f.netAmount),
          currency: priced ? f.currency : null,
          supplierId: f.supplierId || null,
          includedInPackage: f.includedInPackage,
          details,
        });
        if (ok && !initial) setF({ ...f, includedInPackage: false, description: '', amount: '', netAmount: '', hotelName: '', address: '', checkIn: '', checkOut: '', roomType: '', mealPlan: '', route: '', pickupAt: '', vehicle: '' });
      }}
    >
      <h2>{initial ? 'Xizmatni tahrirlash' : 'Yangi xizmat qatori'}</h2>
      <div className="row">
        <Field label="Qator turi">
          <select value={f.serviceType} onChange={set('serviceType')} disabled={!!initial || disabled}>
            {Object.entries(SERVICE_TYPE_LABELS)
              .filter(([k]) => k !== 'tour_package')
              .map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Tavsif">
          <input value={f.description} onChange={set('description')} required disabled={disabled} />
        </Field>
        <Field label="Yetkazib beruvchi">
          <select value={f.supplierId} onChange={set('supplierId')} disabled={disabled}>
            <option value="">—</option>
            {selectable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({SUPPLIER_KIND_LABELS[s.kind] ?? s.kind})
              </option>
            ))}
          </select>
        </Field>
      </div>
      {f.serviceType === 'hotel' && (
        <div className="row">
          <Field label="Mehmonxona nomi">
            <input value={f.hotelName} onChange={set('hotelName')} required disabled={disabled} />
          </Field>
          <Field label="Manzil">
            <input value={f.address} onChange={set('address')} disabled={disabled} />
          </Field>
          <Field label="Kirish sanasi">
            <input type="date" value={f.checkIn} onChange={set('checkIn')} required disabled={disabled} />
          </Field>
          <Field label="Chiqish sanasi">
            <input type="date" value={f.checkOut} onChange={set('checkOut')} required disabled={disabled} />
          </Field>
          <Field label="Xona turi">
            <input value={f.roomType} onChange={set('roomType')} placeholder="Double, Family…" disabled={disabled} />
          </Field>
          <Field label="Ovqatlanish turi">
            <select value={f.mealPlan} onChange={set('mealPlan')} disabled={disabled}>
              <option value="">—</option>
              {MEAL_PLANS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
        </div>
      )}
      {f.serviceType === 'transfer' && (
        <div className="row">
          <Field label="Yo‘nalish">
            <input value={f.route} onChange={set('route')} required placeholder="Aeroport → mehmonxona" disabled={disabled} />
          </Field>
          <Field label="Sana va vaqt">
            <input type="datetime-local" value={f.pickupAt} onChange={set('pickupAt')} required disabled={disabled} />
          </Field>
          <Field label="Transport">
            <input value={f.vehicle} onChange={set('vehicle')} placeholder="Minivan, sedan…" disabled={disabled} />
          </Field>
        </div>
      )}
      <div className="row">
        <Field label="Sotuv narxi">
          <input value={f.amount} onChange={set('amount')} inputMode="decimal" disabled={disabled} />
        </Field>
        <Field label="Tannarx" hint="Bo‘sh = noma’lum">
          <input value={f.netAmount} onChange={set('netAmount')} inputMode="decimal" disabled={disabled} />
        </Field>
        <Field label="Valyuta">
          <select value={f.currency} onChange={set('currency')} disabled={disabled}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <div className="field profit-preview">
          <span className="field-label">Foyda (avtomatik)</span>
          {preview === null ? <span className="muted">—</span> : <b className={isNeg(preview) ? 'neg' : 'pos'}>{fmtMoney(preview, f.currency)}</b>}
        </div>
        <label className="check">
          <input type="checkbox" checked={f.includedInPackage} onChange={(e) => setF({ ...f, includedInPackage: e.target.checked })} style={{ width: 'auto' }} disabled={disabled} /> Paket narxiga kiritilgan (jamiga qo‘shilmasin)
        </label>
      </div>
      <FormError error={error} />
      <div className="row">
        <button className="btn" type="submit" disabled={disabled}>
          {initial ? 'O‘zgarishni saqlash' : 'Xizmatni saqlash'}
        </button>
        {onCancel && (
          <button className="btn secondary" type="button" onClick={onCancel}>
            Bekor qilish
          </button>
        )}
      </div>
    </form>
  );
}
