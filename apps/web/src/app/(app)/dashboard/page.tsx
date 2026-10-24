'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { SOURCE_LABELS, STAGE_LABELS, fmtDateTime, useApi, type Loadable } from '../../../lib/api';
import { Async, Badge, Field } from '../../../components/ui';
import { Icon, type IconName } from '../../../components/icons';
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
const money = (m: Record<string, string>) => (Object.keys(m).length ? Object.entries(m).map(([c, v]) => `${v} ${c}`).join(' · ') : '—');
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
  const [from, setFrom] = useState(() => `${tashkentToday().slice(0, 8)}01`);
  const [to, setTo] = useState(tashkentToday);
  const [source, setSource] = useState('');
  const [bucket, setBucket] = useState('day');
  const [query, setQuery] = useState('');
  const q = new URLSearchParams({ from, to, bucket, ...(source ? { source } : {}) });
  const state = useApi<Dash>(`/api/v1/dashboard?${q}`);
  const notifications = useApi<{ items: Array<{ id: string; readAt: string | null }> }>('/api/v1/notifications');
  const unread = notifications.data?.items.filter((n) => !n.readAt).length ?? 0;
  const flights = useApi<{ items: FlightRow[] }>('/api/v1/flights?limit=5');

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Boshqaruv paneli</h1>
          <p className="muted">
            {from} – {to}
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
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Lid nomi bo‘yicha qidirish…" aria-label="Lid qidirish" />
        </form>
        <Link href="/notifications" className="iconbtn" aria-label={`Bildirishnomalar${unread ? `: ${unread} ta o‘qilmagan` : ''}`}>
          <Icon name="bell" size={20} />
          {unread > 0 && <span className="dot" aria-hidden="true" />}
        </Link>
      </header>

      <section className="filter-card" aria-label="Filtrlar">
        <Field label="Boshlanish (Asia/Tashkent)">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Tugash (kiradi)">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
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
        <Field label="Kesim">
          <select value={bucket} onChange={(e) => setBucket(e.target.value)}>
            <option value="day">Kun</option>
            <option value="week">Hafta</option>
            <option value="month">Oy</option>
          </select>
        </Field>
        {canDo(me, 'export') && (
          <a className="btn secondary with-icon" href={`/api/v1/exports/leads.csv?${q}`}>
            <Icon name="download" size={16} />
            CSV eksport
          </a>
        )}
      </section>

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
              {d.dataQuality.stale && <div className="state stale">Ma’lumotlar eskirgan bo‘lishi mumkin: integratsiya holati to‘liq emas.</div>}

              <div className="stat-row">
                <Stat icon="leads" label="Yangi lidlar" value={pm.newLeads} note={`${pm.inquiries} ta unique murojaat`} />
                <Stat icon="chart" label="Kohorta konversiyasi" value={pm.cohortConversion.display} note={`${pm.cohortConversion.numerator}/${pm.cohortConversion.denominator} lid → sotuv`} />
                <Stat icon="wallet" label="Sotuv summasi (foyda emas)" value={money(pm.salesByCurrency)} note={`Qabul qilingan to‘lov: ${money(pm.paymentsByCurrency)}`} />
                <Stat icon="clock" label="Birinchi javob (median / p90)" value={`${mins(fr.medianSeconds)} / ${mins(fr.p90Seconds)}`} note={`Kuzatilgan ${fr.observed}, javobsiz ${fr.unanswered}`} />
              </div>

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
                Ma’lumotlar to‘liq yig‘ila boshlangan sana: {fmtDateTime(d.dataQuality.dataCollectionStartedAt)} · {d.notes.sourceMode}
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
    </>
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
