'use client';

import { useState } from 'react';
import type { ApiError } from '../lib/api';
import { CURRENCIES, fmtMoney, MEAL_PLANS, profitPreview, SERVICE_TYPE_LABELS, SUPPLIER_KIND_LABELS } from '../lib/format';
import { Badge, Field, FormError, Help, IsoDateField, LocalDateTimeField, Section } from './ui';

/** Tannarx va foyda maydonlari faqat `finance.cost.view` huquqi bo'lsa keladi (`costHidden=false`). */
export interface FinanceView {
  costHidden: boolean;
  hasPrice: boolean;
  profitUndetermined: boolean | null;
  refundCurrencyMismatch: boolean;
  byCurrency: Record<
    string,
    {
      selling: string;
      customerRefunded: string;
      sellingAfterRefund: string;
      lines: number;
      net?: string | null;
      netComplete?: boolean;
      /** Dastlabki foyda (qaytarimsiz). */
      profit?: string | null;
      profitState?: 'known' | 'undetermined';
      marginPercent?: string | null;
      supplierRefunded?: string;
      netAfterRefund?: string | null;
      /** Qaytarimdan keyingi foyda. */
      profitAfterRefund?: string | null;
      missingNetLines?: number;
    }
  >;
  formula: string | null;
}

export interface SupplierRefundView {
  id: string;
  amount: string;
  currency: string;
  receivedAt: string;
  supplierId: string | null;
  reference: string | null;
  note: string | null;
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
  const cost = !finance.costHidden;
  if (!cost) {
    return (
      <Section title="Sotuv va qaytarimlar (valyutalar alohida)">
        {rows.length === 0 ? (
          <div className="state empty">Narx hali kiritilmagan.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Valyuta</th>
                  <th>Sotuv narxi</th>
                  <th>Mijozga qaytarilgan</th>
                  <th>Qaytarimdan keyingi sotuv</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([ccy, r]) => (
                  <tr key={ccy}>
                    <td>{ccy}</td>
                    <td>{fmtMoney(r.selling, ccy)}</td>
                    <td>{fmtMoney(r.customerRefunded, ccy)}</td>
                    <td>{fmtMoney(r.sellingAfterRefund, ccy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">Tannarx va foydani ko‘rish uchun alohida ruxsat kerak (administrator beradi).</p>
      </Section>
    );
  }
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
                <th>Dastlabki foyda</th>
                <th>Marja</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([ccy, r]) => (
                <tr key={ccy}>
                  <td>{ccy}</td>
                  <td>{fmtMoney(r.selling, ccy)}</td>
                  <td>
                    {r.net == null ? <span className="muted">kiritilmagan</span> : fmtMoney(r.net, ccy)}
                    {r.net != null && !r.netComplete && <div className="muted">qisman ({r.missingNetLines} qatorda yo‘q)</div>}
                  </td>
                  <td>
                    <ProfitCell profit={r.profit ?? null} currency={ccy} />
                    {r.profit == null && <div className="muted">Tannarx to‘liq emas — 0 deb hisoblanmaydi</div>}
                  </td>
                  <td>{r.marginPercent == null ? '—' : `${r.marginPercent.replace('.', ',')}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 0 && (
        <>
          <h3>Qaytarimdan keyingi holat</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Valyuta</th>
                  <th>Mijozga qaytarilgan</th>
                  <th>Yetkazib beruvchidan qaytgan</th>
                  <th>Sotuv − mijoz qaytarimi</th>
                  <th>Tannarx − yetkazib beruvchi qaytarimi</th>
                  <th>Qaytarimdan keyingi foyda</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([ccy, r]) => (
                  <tr key={ccy}>
                    <td>{ccy}</td>
                    <td>{fmtMoney(r.customerRefunded, ccy)}</td>
                    <td>{fmtMoney(r.supplierRefunded ?? '0.00', ccy)}</td>
                    <td>{fmtMoney(r.sellingAfterRefund, ccy)}</td>
                    <td>{r.netAfterRefund == null ? <span className="muted">—</span> : fmtMoney(r.netAfterRefund, ccy)}</td>
                    <td>
                      <ProfitCell profit={r.profitAfterRefund ?? null} currency={ccy} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {finance.refundCurrencyMismatch && <div className="state error">Qaytarim valyutasi buyurtma narxlari valyutasiga mos emas — qaytarimdan keyingi foyda hisoblanmadi.</div>}
        </>
      )}
      <p className="hint">
        <b>Dastlabki foyda = sotuv narxi − tannarx.</b> <b>Qaytarimdan keyingi foyda = (sotuv − mijozga qaytarilgan summa) − (tannarx − yetkazib beruvchidan qaytgan summa).</b> Foyda avtomatik hisoblanadi va qo‘lda tahrirlanmaydi; manfiy bo‘lishi mumkin. Qo‘shimcha xarajatlar (komissiya, soliq, bank to‘lovlari, valyuta farqi) hisobga olinmagan, shuning uchun bu buxgalteriya bo‘yicha yakuniy «sof foyda» emas. Turpaket narxi va uning ichiga kiritilgan xizmatlar ikki marta sanalmaydi.
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
export function PricingForm({ order, disabled, canCost = true, onSave }: { order: PricingOrder; disabled?: boolean; canCost?: boolean; onSave: (b: Record<string, unknown>) => void }) {
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
          ...(hasPricing ? { currency, ...(amount ? { agreedAmount: amount } : {}), ...(canCost ? { netPrice: net || null } : {}) } : {}),
        });
      }}
    >
      <div className="row">
        <Field label="Sotuv narxi (mijozga, selling price)">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="1200.00" disabled={disabled} />
        </Field>
        {canCost && (
          <Field label="Tannarx (turoperatordan, net price)" hint="Bo‘sh = noma’lum (0 emas)">
            <input value={net} onChange={(e) => setNet(e.target.value)} inputMode="decimal" placeholder="1000.00" disabled={disabled} />
          </Field>
        )}
        <Field label="Valyuta">
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={disabled}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        {canCost && (
          <div className="field profit-preview" aria-live="polite">
            <span className="field-label">Foyda (avtomatik)</span>
            {preview === null ? <span className="muted">{amount ? 'tannarx kiriting' : '—'}</span> : <b className={isNeg(preview) ? 'neg' : 'pos'}>{fmtMoney(preview, currency)}</b>}
          </div>
        )}
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
  canCost = true,
}: {
  services: ServiceView[];
  suppliers: SupplierRef[];
  canCost?: boolean;
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
        Jami = turpaket narxi + paketdan <b>tashqari</b> xizmatlar. «Paketga kiritilgan» xizmat jamiga qo‘shilmaydi.
        <Help label="Xizmatlar haqida">Har bir xizmatda sotuv narxi, tannarx va yetkazib beruvchi alohida bo‘lishi mumkin. Reyslar «Reys segmentlari» bo‘limida.</Help>
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
                {canCost && <th>Tannarx</th>}
                {canCost && <th>Foyda</th>}
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
                  {canCost && <td>{s.netAmount === null ? <span className="muted">—</span> : fmtMoney(s.netAmount, s.currency)}</td>}
                  {canCost && <td>{s.profit === null ? <span className="muted">—</span> : <b className={isNeg(s.profit) ? 'neg' : 'pos'}>{fmtMoney(s.profit, s.currency)}</b>}</td>}
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
        canCost={canCost}
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
  canCost,
  disabled,
  error,
  onSubmit,
  onCancel,
}: {
  initial: ServiceView | null;
  suppliers: SupplierRef[];
  canCost: boolean;
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
          ...(canCost ? { netAmount: str(f.netAmount) } : {}),
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
            <IsoDateField value={f.checkIn} onValue={(v) => set('checkIn')({ target: { value: v } } as never)} required disabled={disabled} />
          </Field>
          <Field label="Chiqish sanasi">
            <IsoDateField value={f.checkOut} onValue={(v) => set('checkOut')({ target: { value: v } } as never)} required disabled={disabled} />
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
            <LocalDateTimeField value={f.pickupAt} onValue={(v) => set('pickupAt')({ target: { value: v } } as never)} required disabled={disabled} />
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
        {canCost && (
          <Field label="Tannarx" hint="Bo‘sh = noma’lum">
            <input value={f.netAmount} onChange={set('netAmount')} inputMode="decimal" disabled={disabled} />
          </Field>
        )}
        <Field label="Valyuta">
          <select value={f.currency} onChange={set('currency')} disabled={disabled}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        {canCost && (
          <div className="field profit-preview">
            <span className="field-label">Foyda (avtomatik)</span>
            {preview === null ? <span className="muted">—</span> : <b className={isNeg(preview) ? 'neg' : 'pos'}>{fmtMoney(preview, f.currency)}</b>}
          </div>
        )}
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

/** Yetkazib beruvchidan qaytgan summa — mijozga qaytarimdan ALOHIDA qayd etiladi (faqat tannarx huquqi bilan). */
export function SupplierRefundsSection({
  refunds,
  suppliers,
  defaultCurrency,
  disabled,
  error,
  onAdd,
}: {
  refunds: SupplierRefundView[];
  suppliers: SupplierRef[];
  defaultCurrency: string | null;
  disabled?: boolean;
  error: ApiError | null;
  onAdd: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [f, setF] = useState({ amount: '', currency: defaultCurrency ?? 'USD', receivedAt: new Date().toISOString().slice(0, 10), supplierId: '', reference: '', note: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const nameOf = (id: string | null) => suppliers.find((x) => x.id === id)?.name ?? '—';
  return (
    <Section title="Yetkazib beruvchidan qaytgan summa">
      <p className="muted">Yetkazib beruvchi bizga qaytargan pul (mijoz qaytarimidan alohida). Valyuta buyurtma valyutasiga mos bo‘lishi va tannarxdan oshmasligi kerak.</p>
      {refunds.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Sana</th>
                <th>Summa</th>
                <th>Yetkazib beruvchi</th>
                <th>Hujjat / izoh</th>
              </tr>
            </thead>
            <tbody>
              {refunds.map((r) => (
                <tr key={r.id}>
                  <td>{r.receivedAt.slice(0, 10)}</td>
                  <td>{fmtMoney(r.amount, r.currency)}</td>
                  <td>{nameOf(r.supplierId)}</td>
                  <td>{[r.reference, r.note].filter(Boolean).join(' · ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await onAdd({
            amount: f.amount,
            currency: f.currency,
            receivedAt: new Date(`${f.receivedAt}T12:00:00Z`).toISOString(),
            supplierId: f.supplierId || null,
            reference: str(f.reference),
            note: str(f.note),
          });
          if (ok) setF({ ...f, amount: '', reference: '', note: '' });
        }}
      >
        <div className="row">
          <Field label="Qaytgan summa">
            <input value={f.amount} onChange={set('amount')} inputMode="decimal" required disabled={disabled} />
          </Field>
          <Field label="Valyuta">
            <select value={f.currency} onChange={set('currency')} disabled={disabled}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Qabul qilingan sana">
            <IsoDateField value={f.receivedAt} onValue={(v) => set('receivedAt')({ target: { value: v } } as never)} required disabled={disabled} />
          </Field>
          <Field label="Yetkazib beruvchi">
            <select value={f.supplierId} onChange={set('supplierId')} disabled={disabled}>
              <option value="">—</option>
              {suppliers.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Hujjat raqami">
            <input value={f.reference} onChange={set('reference')} disabled={disabled} />
          </Field>
          <Field label="Sabab">
            <input value={f.note} onChange={set('note')} disabled={disabled} />
          </Field>
        </div>
        <FormError error={error} />
        <button className="btn" type="submit" disabled={disabled}>
          Yetkazib beruvchi qaytarimini qayd etish
        </button>
      </form>
    </Section>
  );
}
