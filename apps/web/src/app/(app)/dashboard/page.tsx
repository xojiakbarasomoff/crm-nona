'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { SOURCE_LABELS, STAGE_LABELS, fmtDate, fmtDateTime, isoToDmy, parseDmy, useApi, type Loadable } from '../../../lib/api';
import { Async, Badge, DateInput, Field, InstagramLink } from '../../../components/ui';
import { Icon, type IconName } from '../../../components/icons';
import { CURRENCIES, fmtAmount, money, CURRENCY_LABEL } from '../../../lib/format';
import { canDo, useMe } from '../../../components/shell';

interface Ratio {
  display: string;
  numerator: number;
  denominator: number;
}
interface Dash {
  period: { from: string; to: string; timezone: string };
  periodMetrics: {
    newLeads: number;
    inquiries: number;
    adsLeads: number;
    directLeads: number;
    bySource: Record<string, number>;
    processed: number;
    won: number;
    lost: number;
    cancelledOrders: number;
    cohortConversion: Ratio;
    closedConversion: Ratio;
    salesByCurrency: Record<string, string>;
    paymentsByCurrency: Record<string, string>;
    refundsByCurrency: Record<string, string>;
    firstResponse: { observed: number; answered: number; unanswered: number; medianSeconds: number | null; p90Seconds: number | null; slaWorkingMinutesMedian: number | null };
  };
  snapshot: { inProgress: number; awaitingReply: number; asOf: string };
  funnel: Record<string, number>;
  series: Array<{ bucket: string; newLeads: number; won: number }>;
  managers: Array<{ userId: string | null; name: string; newLeads: number; won: number; inProgress: number; conversion: { display: string }; salesByCurrency: Record<string, string> }>;
  notes: Record<string, string>;
  dataQuality: { dataCollectionStartedAt: string; lastSyncAt: string | null; stale: boolean };
  finance: FinanceDash;
}

/** Tannarx/foyda maydonlari faqat `finance.cost.view` huquqi bo'lsa keladi (aks holda `costHidden=true`). */
interface Agg {
  sales: string;
  customerRefunded: string;
  ordersWithRefund: number;
  supplierRefunded?: string;
  /** Dastlabki foyda: sotuv − tannarx (tannarxi aniq buyurtmalar bo'yicha). */
  profitBasis?: { sales: string; net: string; profit: string; orders: number; marginPercent: string | null };
  /** Qaytarimdan keyingi: (sotuv − mijozga qaytarilgan) − (tannarx − yetkazib beruvchidan qaytgan). */
  afterRefund?: { sales: string; net: string; profit: string; marginPercent: string | null };
  undetermined?: { orders: number; sales: string };
}
interface FinanceDash {
  costHidden: boolean;
  rules: Record<string, string>;
  confirmed: Record<string, Agg>;
  undeterminedOrders: number | null;
  unpricedOrders: number;
  refundMismatchOrders: number | null;
  expected: Record<string, { profit: string; orders: number; undeterminedOrders: number }>;
  cancelled: Record<string, { sales: string; orders: number }>;
  byOperator: Array<{ operatorId: string | null; name: string; orders: number; undeterminedOrders: number | null; currencies: Record<string, Agg> }>;
  byManager: Array<{ userId: string | null; name: string; orders: number; undeterminedOrders: number | null; currencies: Record<string, Agg> }>;
}

interface FlightRow {
  id: string;
  orderId: string;
  orderNo: string;
  customer: string | null;
  ownerName: string | null;
  originIata: string;
  destinationIata: string;
  marketingCarrier: string;
  flightNumber: string;
  departureAtUtc: string | null;
  departureLocal: string | null;
  checkState: string;
  operationalStatus: string;
}

/** Bugungi sana kompaniya vaqt zonasida (Asia/Tashkent), brauzer/UTC zonasida emas. */
const tashkentToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
const mins = (s: number | null) => (s === null ? '—' : `${Math.round(s / 60)} daq`);
const initials = (name: string) =>
  name
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || '—';
const pct = (r: number) => `${(r * 100).toFixed(1).replace(/,?\.0$/, '').replace('.', ',')}%`;
const WON_STAGE = 'WON';
const LOST_STAGE = 'LOST';

export default function DashboardPage() {
  const me = useMe();
  const router = useRouter();
  const defaults = () => ({ from: `${tashkentToday().slice(0, 8)}01`, to: tashkentToday(), source: '', bucket: 'day', operator: '', currency: '' });
  // Qoralama (maydonlardagi qiymat) va qo'llangan filtr alohida: natijalar faqat «Qidirish» bosilganda yangilanadi.
  const [from, setFrom] = useState(() => isoToDmy(defaults().from));
  const [to, setTo] = useState(() => isoToDmy(defaults().to));
  const [source, setSource] = useState('');
  const [bucket, setBucket] = useState('day');
  const [operator, setOperator] = useState('');
  const [currency, setCurrency] = useState('');
  const [applied, setApplied] = useState(defaults);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const apply = () => {
    const f = parseDmy(from);
    const t = parseDmy(to);
    if (!f || !t) return setFilterError('Sanani DD.MM.YYYY ko‘rinishida kiriting (masalan, 25.10.2026).');
    if (f > t) return setFilterError('Boshlanish sanasi tugash sanasidan keyin bo‘lishi mumkin emas.');
    setFilterError(null);
    setApplied({ from: f, to: t, source, bucket, operator, currency });
  };
  const clear = () => {
    const d = defaults();
    setFrom(isoToDmy(d.from));
    setTo(isoToDmy(d.to));
    setSource('');
    setBucket('day');
    setOperator('');
    setCurrency('');
    setFilterError(null);
    setApplied(d);
  };
  const q = new URLSearchParams({ from: applied.from, to: applied.to, bucket: applied.bucket, ...(applied.source ? { source: applied.source } : {}), ...(applied.operator ? { tourOperatorId: applied.operator } : {}), ...(applied.currency ? { currency: applied.currency } : {}) });
  const state = useApi<Dash>(`/api/v1/dashboard?${q}`, { reset: true });
  const notifications = useApi<{ items: Array<{ id: string; readAt: string | null }> }>('/api/v1/notifications');
  const unread = notifications.data?.items.filter((n) => !n.readAt).length ?? 0;
  const flights = useApi<{ items: FlightRow[] }>('/api/v1/flights?limit=5');
  const operators = useApi<{ items: Array<{ id: string; name: string; status: string }> }>('/api/v1/suppliers?status=all&kind=tour_operator');

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Boshqaruv paneli</h1>
          <p className="muted">
            {fmtDate(applied.from)} – {fmtDate(applied.to)}
            {state.data ? ` · Oxirgi sinxronlash: ${fmtDateTime(state.data.dataQuality.lastSyncAt)}` : ''}
          </p>
        </div>
        <form
          className="searchbox"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            router.push(`/leads${query.trim() ? `?search=${encodeURIComponent(query.trim())}` : ''}`);
          }}
        >
          <Icon name="search" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Lid, mijoz, telefon, @username…" aria-label="Lid qidirish" />
        </form>
        <Link href="/notifications" className="iconbtn" aria-label={`Bildirishnomalar${unread ? `: ${unread} ta o‘qilmagan` : ''}`}>
          <Icon name="bell" size={20} />
          {unread > 0 && <span className="dot" aria-hidden="true" />}
        </Link>
      </header>

      <section className="filter-card" aria-label="Filtrlar">
        <Field label="Boshlanish (Asia/Tashkent)">
          <DateInput value={from} onChange={setFrom} label="Boshlanish sanasi (DD.MM.YYYY)" />
        </Field>
        <Field label="Tugash (kiradi)">
          <DateInput value={to} onChange={setTo} label="Tugash sanasi (DD.MM.YYYY)" />
        </Field>
        <Field label="Birinchi manba">
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Barchasi</option>
            {Object.entries(SOURCE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Turoperator">
          <select value={operator} onChange={(e) => setOperator(e.target.value)}>
            <option value="">Barchasi</option>
            {(operators.data?.items ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.status === 'archived' ? ' (arxiv)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Valyuta">
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="">Barchasi</option>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kesim">
          <select value={bucket} onChange={(e) => setBucket(e.target.value)}>
            <option value="day">Kun</option>
            <option value="week">Hafta</option>
            <option value="month">Oy</option>
          </select>
        </Field>
        <div className="filter-actions" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <button className="btn" type="button" onClick={apply}>
            Qidirish
          </button>
          <button className="btn secondary" type="button" onClick={clear}>
            Tozalash
          </button>
        </div>
        {canDo(me, 'export') && (
          <a className="btn secondary with-icon" href={`/api/v1/exports/leads.csv?${q}`}>
            <Icon name="download" size={16} />
            CSV eksport
          </a>
        )}
        {canDo(me, 'export') && (
          <a className="btn secondary with-icon" href={`/api/v1/exports/orders.csv?${q}`}>
            <Icon name="download" size={16} />
            Buyurtmalar CSV (foyda)
          </a>
        )}
      </section>
      {filterError && (
        <div className="state error" role="alert">
          {filterError}
        </div>
      )}

      <Async state={state}>
        {(d) => {
          const pm = d.periodMetrics;
          const funnelStages = Object.keys(STAGE_LABELS).filter((k) => k !== LOST_STAGE);
          const totalInFunnel = Object.values(d.funnel).reduce((a, b) => a + b, 0);
          const maxStage = Math.max(1, ...funnelStages.map((k) => d.funnel[k] ?? 0));
          const maxLeads = Math.max(1, ...d.managers.map((m) => m.newLeads));
          const fr = pm.firstResponse;
          return (
            <>
              <div className="stat-row">
                <Stat icon="leads" label="Yangi lidlar" value={pm.newLeads} note={`${pm.inquiries} ta unique murojaat`} />
                <Stat icon="chart" label="Kohorta konversiyasi" value={pm.cohortConversion.display} note={`${pm.cohortConversion.numerator}/${pm.cohortConversion.denominator} lid → sotuv`} />
                <Stat icon="wallet" label="Sotuv summasi (foyda emas)" value={money(pm.salesByCurrency)} note={`Qabul qilingan to‘lov: ${money(pm.paymentsByCurrency)}`} />
                <Stat icon="clock" label="Birinchi javob (median / p90)" value={`${mins(fr.medianSeconds)} / ${mins(fr.p90Seconds)}`} note={`Kuzatilgan ${fr.observed}, javobsiz ${fr.unanswered}`} />
              </div>

              <FinanceBlock f={d.finance} />

              <div className="dash-grid">
                <section className="card panel">
                  <header className="card-head">
                    <h2>Savdo voronkasi</h2>
                    <span className="muted">hozirgi holat · {fmtDateTime(d.snapshot.asOf)}</span>
                  </header>
                  <div className="funnel">
                    {funnelStages.map((k) => {
                      const n = d.funnel[k] ?? 0;
                      return (
                        <div key={k} className={`funnel-row${k === WON_STAGE ? ' won' : ''}`}>
                          <span className="funnel-label">{STAGE_LABELS[k]}</span>
                          <span className="track" aria-hidden="true">
                            {n > 0 && <span className="fill" style={{ width: `${(n / maxStage) * 100}%` }} />}
                          </span>
                          <span className="funnel-val">
                            <b>{n}</b>
                            <small>{totalInFunnel ? pct(n / totalInFunnel) : '—'}</small>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="cancel-strip">
                    <Icon name="x" size={16} />
                    <b>
                      {STAGE_LABELS[LOST_STAGE]}: {d.funnel[LOST_STAGE] ?? 0}
                    </b>
                  </div>
                </section>

                <section className="card panel">
                  <header className="card-head">
                    <h2>Menejerlar</h2>
                    <span className="muted">tanlangan davr</span>
                  </header>
                  <div className="mgr-head" aria-hidden="true">
                    <span>Menejer</span>
                    <span>Lid</span>
                    <span>Konv.</span>
                    <span>Summa</span>
                  </div>
                  {d.managers.map((m) => (
                    <div key={m.userId ?? 'none'} className="mgr-row">
                      <span className="mgr-who">
                        <span className="avatar pink" aria-hidden="true">
                          {initials(m.name)}
                        </span>
                        <span>
                          <b>{m.name}</b>
                          <small className="muted">
                            {m.won} sotuv · {m.inProgress} jarayonda
                          </small>
                          <span className="mini-track" aria-hidden="true">
                            <span style={{ width: `${(m.newLeads / maxLeads) * 100}%` }} />
                          </span>
                        </span>
                      </span>
                      <span>{m.newLeads}</span>
                      <span>{m.conversion.display}</span>
                      <b>{money(m.salesByCurrency)}</b>
                    </div>
                  ))}
                  <p className="muted">{d.notes.managerAttribution}</p>
                </section>
              </div>

              <FlightsCard state={flights} />

              <h2 className="section-title">Qo‘shimcha ko‘rsatkichlar</h2>
              <p className="muted">
                Ma’lumotlar to‘liq yig‘ila boshlangan sana: {fmtDateTime(d.dataQuality.dataCollectionStartedAt)}
              </p>
              <div className="grid" style={{ margin: '10px 0 18px' }}>
                <Kpi label="Murojaatlar (unique)" value={pm.inquiries} />
                <Kpi label="Ads lidlari" value={pm.adsLeads} />
                <Kpi label="Direct lidlari" value={pm.directLeads} />
                <Kpi label="Qayta ishlangan" value={pm.processed} />
                <Kpi label="Muvaffaqiyatli sotuvlar" value={pm.won} />
                <Kpi label="Bekor qilingan lidlar" value={pm.lost} />
                <Kpi label="Bekor qilingan buyurtmalar" value={pm.cancelledOrders} />
                <Kpi label="Yopilganlar konversiyasi" value={pm.closedConversion.display} hint={`${pm.closedConversion.numerator}/${pm.closedConversion.denominator}`} />
                <Kpi label="Qaytarim" value={money(pm.refundsByCurrency)} />
                <Kpi label="Ish vaqti bo‘yicha birinchi javob (median)" value={fr.slaWorkingMinutesMedian === null ? '—' : `${fr.slaWorkingMinutesMedian} daq`} />
                <Kpi label="Jarayonda (snapshot)" value={d.snapshot.inProgress} />
                <Kpi label="Javob kutilmoqda (snapshot)" value={d.snapshot.awaitingReply} />
              </div>

              <div className="split">
                <section className="card panel">
                  <header className="card-head">
                    <h2>Kunlar bo‘yicha</h2>
                  </header>
                  <Bars rows={d.series.map((s) => ({ label: s.bucket, a: s.newLeads, b: s.won }))} />
                </section>
                <section className="card panel">
                  <header className="card-head">
                    <h2>Manbalar (birinchi manba)</h2>
                  </header>
                  {Object.entries(pm.bySource).map(([k, v]) => (
                    <div key={k} className="source-row">
                      <span>{SOURCE_LABELS[k] ?? k}</span>
                      <b>{v}</b>
                    </div>
                  ))}
                  <p className="muted">
                    <Badge tone="info">CPL/ROAS</Badge> reklama sarfi ma’lumoti ulanmagani uchun hisoblanmaydi. {d.notes.currency}
                  </p>
                </section>
              </div>
            </>
          );
        }}
      </Async>
      <DashLeads query={q.toString()} />
    </>
  );
}

interface DashLead {
  id: string;
  name: string;
  stage: string;
  source: string;
  ownerId: string | null;
  createdAt: string;
  contactName: string | null;
  instagramUsername: string | null;
  telegramUsername: string | null;
}

/** Filtrga mos lidlar (yaratilgan sana bo'yicha): yuklanish, xato va bo'sh natija alohida ko'rinadi; eski davr natijasi saqlanmaydi. */
function DashLeads({ query }: { query: string }) {
  const res = useApi<{ total: number; truncated: boolean; items: DashLead[] }>(`/api/v1/dashboard/leads?${query}`, { reset: true });
  const team = useApi<{ items: Array<{ id: string; fullName: string }> }>('/api/v1/team');
  const owner = (id: string | null) => team.data?.items.find((u) => u.id === id)?.fullName ?? (id ? '—' : 'Taqsimlanmagan');
  return (
    <section className="card panel" aria-label="Filtrga mos lidlar">
      <header className="card-head">
        <h2>Filtrga mos lidlar</h2>
        <span className="muted">{res.data ? `Topilgan lidlar: ${res.data.total}${res.data.truncated ? ` (birinchi ${res.data.items.length} tasi ko‘rsatilgan)` : ''}` : ''}</span>
      </header>
      {res.loading && !res.data && <div className="state">Yuklanmoqda…</div>}
      {res.error && !res.data && (
        <div className="state error" role="alert">
          So‘rov xatosi: {res.error.message}{' '}
          <button className="btn secondary" type="button" onClick={() => void res.reload()}>
            Qayta urinish
          </button>
        </div>
      )}
      {res.data && res.data.items.length === 0 && <div className="state empty">Tanlangan davrda ma’lumot topilmadi</div>}
      {res.data && res.data.items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Mijoz / @username</th>
                <th>Manba</th>
                <th>Mas’ul</th>
                <th>Bosqich</th>
                <th>Yaratilgan</th>
                <th>Karta</th>
              </tr>
            </thead>
            <tbody>
              {res.data.items.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.instagramUsername ? <InstagramLink username={l.instagramUsername} /> : l.contactName ?? l.name}
                    {l.telegramUsername ? <span className="muted"> · @{l.telegramUsername}</span> : null}
                  </td>
                  <td>{SOURCE_LABELS[l.source] ?? l.source}</td>
                  <td>{owner(l.ownerId)}</td>
                  <td>{STAGE_LABELS[l.stage] ?? l.stage}</td>
                  <td>{fmtDateTime(l.createdAt)}</td>
                  <td>
                    <Link href={`/leads/${l.id}`}>{l.name}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const isNeg = (v: string) => v.startsWith('-');

/** Foyda: tannarxi aniq buyurtma bo'lmasa «Aniqlanmagan» (0 emas); qisman bo'lsa belgi bilan. */
function ProfitText({ a, c }: { a: Agg; c: string }) {
  if (!a.profitBasis || a.profitBasis.orders === 0) return <Badge tone="warn">Aniqlanmagan</Badge>;
  return (
    <>
      <b className={a.profitBasis.profit.startsWith('-') ? 'neg' : 'pos'}>{money({ [c]: a.profitBasis.profit })}</b>
      {a.afterRefund && a.ordersWithRefund > 0 && (
        <div className="muted">
          qaytarimdan keyin: <b className={a.afterRefund.profit.startsWith('-') ? 'neg' : 'pos'}>{money({ [c]: a.afterRefund.profit })}</b>
        </div>
      )}
      {a.undetermined && a.undetermined.orders > 0 && <span className="muted" title="Tannarxi kiritilmagan buyurtmalar foydaga kirmaydi"> *</span>}
    </>
  );
}
const profitCls = (v: string) => (isNeg(v) ? 'neg' : 'pos');
const sel = (m: Record<string, unknown>) => Object.keys(m);

/** Tasdiqlangan sotuvlar bo'yicha sotuv / tannarx / foyda (valyutalar alohida), kutilayotgan foyda va kesimlar. */
function FinanceBlock({ f }: { f: FinanceDash }) {
  const ccys = sel(f.confirmed);
  const cost = !f.costHidden;
  const cell = (m: Record<string, Agg>, pick: (a: Agg, c: string) => React.ReactNode) =>
    sel(m).length ? (
      sel(m).map((c) => (
        <div key={c}>{pick(m[c]!, c)}</div>
      ))
    ) : (
      <span className="muted">—</span>
    );
  return (
    <section className="finance-block" aria-label="Moliyaviy ko‘rsatkichlar">
      <div className="card panel">
        <header className="card-head">
          <h2>{cost ? 'Moliya: sotuv, tannarx va foyda' : 'Moliya: sotuv va qaytarimlar'}</h2>
          <span className="muted">tasdiqlangan sotuvlar · valyutalar alohida</span>
        </header>
        {!cost && <p className="muted">Tannarx va foyda ko‘rinmaydi: alohida ruxsat kerak.</p>}
        {ccys.length === 0 ? (
          <div className="state empty">Tanlangan davrda tasdiqlangan (yopilgan) sotuv yo‘q.</div>
        ) : (
          ccys.map((c) => {
            const a = f.confirmed[c]!;
            const pb = a.profitBasis;
            return (
              <div key={c} className="fin-ccy">
                <h3 className="fin-ccy-title">{c}</h3>
                <div className="stat-row">
                  <div className="stat">
                    <div className="stat-label">Jami sotuv summasi</div>
                    <div className="stat-value">{fmtAmount(a.sales)} <small>{CURRENCY_LABEL[c] ?? c}</small></div>
                    <div className="stat-note">barcha tasdiqlangan buyurtmalar</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Mijozga qaytarilgan</div>
                    <div className="stat-value">{fmtAmount(a.customerRefunded)} <small>{CURRENCY_LABEL[c] ?? c}</small></div>
                    <div className="stat-note">{a.ordersWithRefund} ta buyurtmada qaytarim bor</div>
                  </div>
                  {cost && pb && (
                    <>
                      <div className="stat">
                        <div className="stat-label">Jami tannarx</div>
                        {pb.orders === 0 ? <div className="stat-value">—</div> : <div className="stat-value">{fmtAmount(pb.net)} <small>{CURRENCY_LABEL[c] ?? c}</small></div>}
                        <div className="stat-note">{pb.orders === 0 ? 'tannarxi ma’lum buyurtma yo‘q' : `tannarxi ma’lum ${pb.orders} ta buyurtma bo‘yicha`}</div>
                      </div>
                      <div className="stat">
                        <div className="stat-label">Dastlabki foyda</div>
                        {pb.orders === 0 ? (
                          <div className="stat-value">
                            <Badge tone="warn">Aniqlanmagan</Badge>
                          </div>
                        ) : (
                          <div className={`stat-value ${profitCls(pb.profit)}`}>{fmtAmount(pb.profit)} <small>{CURRENCY_LABEL[c] ?? c}</small></div>
                        )}
                        <div className="stat-note">
                          {pb.orders === 0 ? 'tannarx kiritilmaguncha hisoblanmaydi' : `sotuv ${fmtAmount(pb.sales)} − tannarx ${fmtAmount(pb.net)}`}
                          {pb.orders > 0 && pb.marginPercent !== null && ` · marja ${pb.marginPercent.replace('.', ',')}%`}
                        </div>
                      </div>
                      <div className="stat">
                        <div className="stat-label">Yetkazib beruvchidan qaytgan</div>
                        <div className="stat-value">{fmtAmount(a.supplierRefunded ?? '0.00')} <small>{CURRENCY_LABEL[c] ?? c}</small></div>
                        <div className="stat-note">tannarxni qaytarish (mijoz qaytarimidan alohida)</div>
                      </div>
                      <div className="stat">
                        <div className="stat-label">Qaytarimdan keyingi foyda</div>
                        {pb.orders === 0 || !a.afterRefund ? (
                          <div className="stat-value">
                            <Badge tone="warn">Aniqlanmagan</Badge>
                          </div>
                        ) : (
                          <div className={`stat-value ${profitCls(a.afterRefund.profit)}`}>{fmtAmount(a.afterRefund.profit)} <small>{CURRENCY_LABEL[c] ?? c}</small></div>
                        )}
                        <div className="stat-note">{a.afterRefund ? `(${fmtAmount(a.afterRefund.sales)}) − (${fmtAmount(a.afterRefund.net)})` : 'tannarx kiritilmaguncha hisoblanmaydi'}</div>
                      </div>
                      <div className="stat">
                        <div className="stat-label">Foyda aniqlanmagan</div>
                        <div className="stat-value">{a.undetermined?.orders ?? 0} <small>ta buyurtma</small></div>
                        <div className="stat-note">tannarx kiritilmagan; sotuvi {fmtAmount(a.undetermined?.sales ?? '0.00')} {CURRENCY_LABEL[c] ?? c} — foydaga kirmaydi, 0 deb hisoblanmaydi</div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
        {f.unpricedOrders > 0 && <p className="hint">Narxi umuman kiritilmagan tasdiqlangan buyurtmalar: {f.unpricedOrders} ta.</p>}
        {cost && !!f.refundMismatchOrders && <div className="state error">{f.refundMismatchOrders} ta buyurtmada qaytarim valyutasi narx valyutasiga mos emas — ularning qaytarimdan keyingi foydasi hisoblanmadi.</div>}
        <div className="fin-extra">
          {cost && (
            <div>
              <b>Kutilayotgan foyda</b> <span className="muted">(ochiq buyurtmalar, tasdiqlanmagan)</span>
              {sel(f.expected).length === 0 ? (
                <div className="muted">—</div>
              ) : (
                sel(f.expected).map((c) => (
                  <div key={c}>
                    <b className={profitCls(f.expected[c]!.profit)}>{money({ [c]: f.expected[c]!.profit })}</b> <span className="muted">· {f.expected[c]!.orders} ta buyurtma{f.expected[c]!.undeterminedOrders ? `, ${f.expected[c]!.undeterminedOrders} tasida tannarx yo‘q` : ''}</span>
                  </div>
                ))
              )}
            </div>
          )}
          <div>
            <b>Bekor qilingan buyurtmalar</b> <span className="muted">(jamiga kirmaydi, tarixda saqlanadi)</span>
            {sel(f.cancelled).length === 0 ? <div className="muted">—</div> : sel(f.cancelled).map((c) => <div key={c}>{money({ [c]: f.cancelled[c]!.sales })} <span className="muted">· {f.cancelled[c]!.orders} ta</span></div>)}
          </div>
        </div>
        <details className="fin-rules">
          <summary>Hisoblash qoidalari</summary>
          <ul>
            {cost && (
              <>
                <li>
                  <b>Dastlabki foyda = sotuv narxi − tannarx.</b>
                </li>
                <li>
                  <b>Qaytarimdan keyingi foyda = (sotuv − mijozga qaytarilgan) − (tannarx − yetkazib beruvchidan qaytgan).</b>
                </li>
                <li>Qo‘shimcha xarajatlar hisobga olinmagan: bu buxgalteriya bo‘yicha yakuniy «sof foyda» emas.</li>
              </>
            )}
            {Object.entries(f.rules).map(([k, v]) => (
              <li key={k}>{v}</li>
            ))}
          </ul>
        </details>
      </div>

      <div className="dash-grid">
        <section className="card panel">
          <header className="card-head">
            <h2>Turoperatorlar kesimida</h2>
            <span className="muted">{cost ? 'sotuv va foyda (turoperator — buyurtmaning tarixiy bog‘lanishi)' : 'sotuv'}</span>
          </header>
          {f.byOperator.length === 0 ? (
            <div className="state empty">Ma’lumot yo‘q</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Turoperator</th>
                    <th>Buyurtma</th>
                    <th>Sotuv</th>
                    {cost && <th>Foyda</th>}
                  </tr>
                </thead>
                <tbody>
                  {f.byOperator.map((r) => (
                    <tr key={r.operatorId ?? 'none'}>
                      <td>
                        <b>{r.name}</b>
                        {cost && !!r.undeterminedOrders && <div className="muted">foyda aniqlanmagan: {r.undeterminedOrders} ta</div>}
                      </td>
                      <td>{r.orders}</td>
                      <td>{cell(r.currencies, (a, c) => money({ [c]: a.sales }))}</td>
                      {cost && <td>{cell(r.currencies, (a, c) => <ProfitText a={a} c={c} />)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="card panel">
          <header className="card-head">
            <h2>Menejerlar kesimida</h2>
            <span className="muted">{cost ? 'sotuv va foyda (yopilish paytidagi mas’ul)' : 'sotuv (yopilish paytidagi mas’ul)'}</span>
          </header>
          {f.byManager.length === 0 ? (
            <div className="state empty">Ma’lumot yo‘q</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Menejer</th>
                    <th>Buyurtma</th>
                    <th>Sotuv</th>
                    {cost && <th>Foyda</th>}
                  </tr>
                </thead>
                <tbody>
                  {f.byManager.map((r) => (
                    <tr key={r.userId ?? 'none'}>
                      <td>
                        <b>{r.name}</b>
                        {cost && !!r.undeterminedOrders && <div className="muted">foyda aniqlanmagan: {r.undeterminedOrders} ta</div>}
                      </td>
                      <td>{r.orders}</td>
                      <td>{cell(r.currencies, (a, c) => money({ [c]: a.sales }))}</td>
                      {cost && <td>{cell(r.currencies, (a, c) => <ProfitText a={a} c={c} />)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function Stat({ icon, label, value, note }: { icon: IconName; label: string; value: string | number; note?: string }) {
  return (
    <div className="stat">
      <div className="stat-head">
        <span className="stat-icon">
          <Icon name={icon} size={20} />
        </span>
        <span className="stat-label">{label}</span>
      </div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

function FlightsCard({ state }: { state: Loadable<{ items: FlightRow[] }> }) {
  // Reys ma’lumotlari bu rol uchun ochiq bo‘lmasa (403) yoki hali yuklanmagan bo‘lsa, blok ko‘rsatilmaydi.
  if (!state.data) return null;
  const rows = state.data.items.slice(0, 5);
  return (
    <section className="card panel">
      <header className="card-head">
        <h2>Yaqin reyslar</h2>
        <span className="legend" aria-label="Rang belgilari">
          <span>
            <i className="sw brand" />
            Brend urg‘usi
          </span>
          <span>
            <i className="sw bad" />
            Tekshirish kerak
          </span>
          <span>
            <i className="sw cancel" />
            Bekor qilingan
          </span>
        </span>
      </header>
      {rows.length === 0 ? (
        <div className="state empty">Yaqin reyslar yo‘q</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reys</th>
                <th>Yo‘nalish</th>
                <th>Uchish</th>
                <th>Mijoz</th>
                <th>Mas’ul</th>
                <th>Qoldi</th>
                <th>Holat</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const st = flightState(s);
                return (
                  <tr key={s.id} className={st.cancelled ? 'row-cancelled' : ''}>
                    <td className="code">
                      <Link href={`/orders/${s.orderId}`}>
                        {s.marketingCarrier} {s.flightNumber}
                      </Link>
                    </td>
                    <td>
                      <b>{s.originIata}</b> <Icon name="flights" size={14} /> <b>{s.destinationIata}</b>
                    </td>
                    <td>{s.departureLocal ? s.departureLocal.replace('T', ' ') : '—'}</td>
                    <td>{s.customer ?? '—'}</td>
                    <td>
                      {s.ownerName ? (
                        <span className="avatar pink sm" title={s.ownerName}>
                          {initials(s.ownerName)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{timeLeft(s.departureAtUtc)}</td>
                    <td>
                      <span className={`pill ${st.tone}`}>
                        <Icon name={st.icon} size={14} />
                        {st.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function flightState(s: FlightRow): { tone: 'ok' | 'warn' | 'bad' | 'cancel' | 'neutral'; icon: IconName; label: string; cancelled: boolean } {
  if (s.operationalStatus === 'cancelled') return { tone: 'cancel', icon: 'x', label: 'Bekor qilingan', cancelled: true };
  if (s.operationalStatus === 'schedule_changed') return { tone: 'warn', icon: 'clock', label: 'Vaqt o‘zgardi', cancelled: false };
  if (s.checkState === 'due' || s.checkState === 'recheck_required') return { tone: 'bad', icon: 'alert', label: 'Tekshirish kerak', cancelled: false };
  if (s.checkState === 'checked') return { tone: 'ok', icon: 'check', label: 'Tekshirilgan', cancelled: false };
  return { tone: 'neutral', icon: 'clock', label: 'Kutilmoqda', cancelled: false };
}

function timeLeft(utc: string | null): string {
  if (!utc) return '—';
  const ms = new Date(utc).getTime() - Date.now();
  if (ms <= 0) return '—';
  const h = Math.floor(ms / 3_600_000);
  return h >= 24 ? `${Math.floor(h / 24)} kun` : `${h} soat`;
}

function Kpi({ label, value, hint }: { label: string; value: string | number; hint?: ReactNode }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="muted">{hint}</div>}
    </div>
  );
}

function Bars({ rows }: { rows: Array<{ label: string; a: number; b: number }> }) {
  const max = Math.max(1, ...rows.map((r) => r.a));
  if (!rows.length) return <div className="state empty">Tanlangan davrda lid yo‘q</div>;
  return (
    <div role="table" aria-label="Yangi lidlar va sotuvlar">
      {rows.map((r) => (
        <div key={r.label} role="row" style={{ display: 'grid', gridTemplateColumns: '90px 1fr 70px', gap: 8, alignItems: 'center', marginBottom: 4 }}>
          <span role="cell" className="muted">
            {r.label}
          </span>
          <span role="cell">
            <div className="bar" style={{ width: `${(r.a / max) * 100}%` }} />
          </span>
          <span role="cell">
            {r.a} / {r.b} WON
          </span>
        </div>
      ))}
    </div>
  );
}
