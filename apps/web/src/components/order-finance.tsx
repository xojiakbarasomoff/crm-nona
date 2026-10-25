'use client';

import { useState } from 'react';
import type { ApiError } from '../lib/api';
import { CURRENCIES, fmtMoney, MEAL_PLANS, profitPreview, SERVICE_TYPE_LABELS, SUPPLIER_KIND_LABELS } from '../lib/format';
import { Badge, Field, FormError, Help, IsoDateField, LocalDateTimeField, Section } from './ui';

/** Поля себестоимости и прибыли приходят только при праве `finance.cost.view` (`costHidden=false`). */
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
      /** Первоначальная прибыль (без возвратов). */
      profit?: string | null;
      profitState?: 'known' | 'undetermined';
      marginPercent?: string | null;
      supplierRefunded?: string;
      netAfterRefund?: string | null;
      /** Прибыль после возвратов. */
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

/** Прибыль считается автоматически и вручную не редактируется. Нет себестоимости — «Не определена» (не 0). */
export function ProfitCell({ profit, currency }: { profit: string | null; currency: string }) {
  if (profit === null) return <Badge tone="warn">Не определена</Badge>;
  return <b className={isNeg(profit) ? 'neg' : 'pos'}>{fmtMoney(profit, currency)}</b>;
}

export function FinanceSummary({ finance }: { finance: FinanceView }) {
  const rows = Object.entries(finance.byCurrency);
  const cost = !finance.costHidden;
  if (!cost) {
    return (
      <Section title="Продажи и возвраты (валюты отдельно)">
        {rows.length === 0 ? (
          <div className="state empty">Цена ещё не указана.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Валюта</th>
                  <th>Цена продажи</th>
                  <th>Возвращено клиенту</th>
                  <th>Продажа после возвратов</th>
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
        <p className="hint">Чтобы видеть себестоимость и прибыль, нужно отдельное разрешение (выдаёт администратор).</p>
      </Section>
    );
  }
  return (
    <Section title="Расчёт прибыли (валюты отдельно)">
      {rows.length === 0 ? (
        <div className="state empty">Цена ещё не указана. Введите цену продажи и себестоимость — прибыль посчитается автоматически.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Валюта</th>
                <th>Цена продажи</th>
                <th>Себестоимость</th>
                <th>Первоначальная прибыль</th>
                <th>Маржа</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([ccy, r]) => (
                <tr key={ccy}>
                  <td>{ccy}</td>
                  <td>{fmtMoney(r.selling, ccy)}</td>
                  <td>
                    {r.net == null ? <span className="muted">не указана</span> : fmtMoney(r.net, ccy)}
                    {r.net != null && !r.netComplete && <div className="muted">частично (нет в строках: {r.missingNetLines})</div>}
                  </td>
                  <td>
                    <ProfitCell profit={r.profit ?? null} currency={ccy} />
                    {r.profit == null && <div className="muted">Себестоимость неполная — не считается за 0</div>}
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
          <h3>Состояние после возвратов</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Валюта</th>
                  <th>Возвращено клиенту</th>
                  <th>Возвращено поставщиком</th>
                  <th>Продажа − возврат клиенту</th>
                  <th>Себестоимость − возврат поставщика</th>
                  <th>Прибыль после возвратов</th>
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
          {finance.refundCurrencyMismatch && <div className="state error">Валюта возврата не совпадает с валютой цен заказа — прибыль после возвратов не рассчитана.</div>}
        </>
      )}
      <p className="hint">
        <b>Первоначальная прибыль = цена продажи − себестоимость.</b> <b>Прибыль после возвратов = (продажа − возвращено клиенту) − (себестоимость − возвращено поставщиком).</b> Прибыль считается автоматически, вручную не редактируется и может быть отрицательной. Дополнительные расходы (комиссии, налоги, банковские платежи, курсовая разница) не учтены, поэтому это не итоговая «чистая прибыль» по бухгалтерии. Цена турпакета и включённые в него услуги не считаются дважды.
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

/** Цена на уровне турпакета: цена продажи, себестоимость, валюта, подтверждение и заметка. */
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
        <Field label="Цена продажи (для клиента)">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="1200.00" disabled={disabled} />
        </Field>
        {canCost && (
          <Field label="Себестоимость (от туроператора)" hint="Пусто = неизвестно (не 0)">
            <input value={net} onChange={(e) => setNet(e.target.value)} inputMode="decimal" placeholder="1000.00" disabled={disabled} />
          </Field>
        )}
        <Field label="Валюта">
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={disabled}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        {canCost && (
          <div className="field profit-preview" aria-live="polite">
            <span className="field-label">Прибыль (автоматически)</span>
            {preview === null ? <span className="muted">{amount ? 'укажите себестоимость' : '—'}</span> : <b className={isNeg(preview) ? 'neg' : 'pos'}>{fmtMoney(preview, currency)}</b>}
          </div>
        )}
      </div>
      <div className="row">
        <Field label="Подтверждение продажи">
          <input value={evidence} onChange={(e) => setEvidence(e.target.value)} disabled={disabled} />
        </Field>
        <Field label="Заметка к заказу">
          <input value={note} onChange={(e) => setNote(e.target.value)} disabled={disabled} />
        </Field>
        <button className="btn" type="submit" disabled={disabled}>
          Сохранить
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
    <Section title="Услуги: отель, трансфер, авиа и другие">
      <p className="muted">
        Итого = цена турпакета + услуги <b>вне</b> пакета. Услуга «Входит в пакет» в итог не добавляется.
        <Help label="Об услугах">У каждой услуги могут быть своя цена продажи, себестоимость и поставщик. Рейсы вносятся в разделе «Сегменты рейса».</Help>
      </p>
      {services.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Тип</th>
                <th>Описание и детали</th>
                <th>Поставщик</th>
                <th>Продажа</th>
                {canCost && <th>Себестоимость</th>}
                {canCost && <th>Прибыль</th>}
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
                    {s.includedInPackage && <Badge tone="info">Входит в пакет — в итог не добавляется</Badge>}
                  </td>
                  <td>{nameOf(s.supplierId) || '—'}</td>
                  <td>{fmtMoney(s.amount, s.currency)}</td>
                  {canCost && <td>{s.netAmount === null ? <span className="muted">—</span> : fmtMoney(s.netAmount, s.currency)}</td>}
                  {canCost && <td>{s.profit === null ? <span className="muted">—</span> : <b className={isNeg(s.profit) ? 'neg' : 'pos'}>{fmtMoney(s.profit, s.currency)}</b>}</td>}
                  <td>
                    <button type="button" className="btn small secondary" disabled={disabled} onClick={() => setEditing(s)}>
                      Редактировать
                    </button>
                    <button
                      type="button"
                      className="btn small secondary"
                      disabled={disabled}
                      onClick={async () => {
                        if (window.confirm(`Удалить услугу «${s.description}»? История сохранится в журнале.`)) await onRemove(s.id);
                      }}
                    >
                      Удалить
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
      <h2>{initial ? 'Редактирование услуги' : 'Новая строка услуги'}</h2>
      <div className="row">
        <Field label="Тип строки">
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
        <Field label="Описание">
          <input value={f.description} onChange={set('description')} required disabled={disabled} />
        </Field>
        <Field label="Поставщик">
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
          <Field label="Название отеля">
            <input value={f.hotelName} onChange={set('hotelName')} required disabled={disabled} />
          </Field>
          <Field label="Адрес">
            <input value={f.address} onChange={set('address')} disabled={disabled} />
          </Field>
          <Field label="Дата заезда">
            <IsoDateField value={f.checkIn} onValue={(v) => set('checkIn')({ target: { value: v } } as never)} required disabled={disabled} />
          </Field>
          <Field label="Дата выезда">
            <IsoDateField value={f.checkOut} onValue={(v) => set('checkOut')({ target: { value: v } } as never)} required disabled={disabled} />
          </Field>
          <Field label="Тип номера">
            <input value={f.roomType} onChange={set('roomType')} placeholder="Double, Family…" disabled={disabled} />
          </Field>
          <Field label="Тип питания">
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
          <Field label="Маршрут">
            <input value={f.route} onChange={set('route')} required placeholder="Аэропорт → отель" disabled={disabled} />
          </Field>
          <Field label="Дата и время">
            <LocalDateTimeField value={f.pickupAt} onValue={(v) => set('pickupAt')({ target: { value: v } } as never)} required disabled={disabled} />
          </Field>
          <Field label="Транспорт">
            <input value={f.vehicle} onChange={set('vehicle')} placeholder="Минивэн, седан…" disabled={disabled} />
          </Field>
        </div>
      )}
      <div className="row">
        <Field label="Цена продажи">
          <input value={f.amount} onChange={set('amount')} inputMode="decimal" disabled={disabled} />
        </Field>
        {canCost && (
          <Field label="Себестоимость" hint="Пусто = неизвестно">
            <input value={f.netAmount} onChange={set('netAmount')} inputMode="decimal" disabled={disabled} />
          </Field>
        )}
        <Field label="Валюта">
          <select value={f.currency} onChange={set('currency')} disabled={disabled}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        {canCost && (
          <div className="field profit-preview">
            <span className="field-label">Прибыль (автоматически)</span>
            {preview === null ? <span className="muted">—</span> : <b className={isNeg(preview) ? 'neg' : 'pos'}>{fmtMoney(preview, f.currency)}</b>}
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={f.includedInPackage} onChange={(e) => setF({ ...f, includedInPackage: e.target.checked })} style={{ width: 'auto' }} disabled={disabled} /> Входит в цену пакета (не добавлять в итог)
        </label>
      </div>
      <FormError error={error} />
      <div className="row">
        <button className="btn" type="submit" disabled={disabled}>
          {initial ? 'Сохранить изменения' : 'Сохранить услугу'}
        </button>
        {onCancel && (
          <button className="btn secondary" type="button" onClick={onCancel}>
            Отмена
          </button>
        )}
      </div>
    </form>
  );
}

/** Сумма, вернувшаяся от поставщика, записывается ОТДЕЛЬНО от возврата клиенту (только с правом на себестоимость). */
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
    <Section title="Возврат от поставщика">
      <p className="muted">Деньги, которые поставщик вернул нам (отдельно от возврата клиенту). Валюта должна совпадать с валютой заказа, а сумма не должна превышать себестоимость.</p>
      {refunds.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Сумма</th>
                <th>Поставщик</th>
                <th>Документ / заметка</th>
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
          <Field label="Возвращённая сумма">
            <input value={f.amount} onChange={set('amount')} inputMode="decimal" required disabled={disabled} />
          </Field>
          <Field label="Валюта">
            <select value={f.currency} onChange={set('currency')} disabled={disabled}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Дата получения">
            <IsoDateField value={f.receivedAt} onValue={(v) => set('receivedAt')({ target: { value: v } } as never)} required disabled={disabled} />
          </Field>
          <Field label="Поставщик">
            <select value={f.supplierId} onChange={set('supplierId')} disabled={disabled}>
              <option value="">—</option>
              {suppliers.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Номер документа">
            <input value={f.reference} onChange={set('reference')} disabled={disabled} />
          </Field>
          <Field label="Причина">
            <input value={f.note} onChange={set('note')} disabled={disabled} />
          </Field>
        </div>
        <FormError error={error} />
        <button className="btn" type="submit" disabled={disabled}>
          Записать возврат от поставщика
        </button>
      </form>
    </Section>
  );
}
