'use client';

import { useState } from 'react';
import { SOURCE_LABELS, STAGE_LABELS, fmtDateTime, useApi } from '../../../lib/api';
import { Async, Badge, Field, Section } from '../../../components/ui';
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

const iso = (d: Date) => d.toISOString().slice(0, 10);
const mins = (s: number | null) => (s === null ? '—' : `${Math.round(s / 60)} daq`);
const money = (m: Record<string, string>) => (Object.keys(m).length ? Object.entries(m).map(([c, v]) => `${v} ${c}`).join(' · ') : '—');

export default function DashboardPage() {
  const me = useMe();
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(iso(now));
  const [source, setSource] = useState('');
  const [bucket, setBucket] = useState('day');
  const q = new URLSearchParams({ from, to, bucket, ...(source ? { source } : {}) });
  const state = useApi<Dash>(`/api/v1/dashboard?${q}`);

  return (
    <>
      <h1>Dashboard</h1>
      <Section title="Filtrlar">
        <div className="row">
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
            <a className="btn secondary" href={`/api/v1/exports/leads.csv?${q}`}>
              CSV eksport
            </a>
          )}
        </div>
      </Section>
      <Async state={state}>
        {(d) => (
          <>
            {d.dataQuality.stale && <div className="state stale">Ma’lumotlar eskirgan bo‘lishi mumkin: integratsiya holati to‘liq emas.</div>}
            <p className="muted">
              Ma’lumotlar to‘liq yig‘ila boshlangan sana: {fmtDateTime(d.dataQuality.dataCollectionStartedAt)} · Oxirgi sinxronlash: {fmtDateTime(d.dataQuality.lastSyncAt)} · {d.notes.sourceMode}
            </p>
            <h2>Davr ko‘rsatkichlari</h2>
            <div className="grid" style={{ margin: '10px 0 18px' }}>
              <Kpi label="Yangi lidlar" value={d.periodMetrics.newLeads} />
              <Kpi label="Murojaatlar (unique)" value={d.periodMetrics.inquiries} />
              <Kpi label="Ads lidlari" value={d.periodMetrics.adsLeads} />
              <Kpi label="Direct lidlari" value={d.periodMetrics.directLeads} />
              <Kpi label="Qayta ishlangan" value={d.periodMetrics.processed} />
              <Kpi label="Muvaffaqiyatli sotuvlar" value={d.periodMetrics.won} />
              <Kpi label="Bekor qilingan lidlar" value={d.periodMetrics.lost} />
              <Kpi label="Bekor qilingan buyurtmalar" value={d.periodMetrics.cancelledOrders} />
              <Kpi label="Kohorta konversiyasi" value={d.periodMetrics.cohortConversion.display} hint={`${d.periodMetrics.cohortConversion.numerator}/${d.periodMetrics.cohortConversion.denominator}`} />
              <Kpi label="Yopilganlar konversiyasi" value={d.periodMetrics.closedConversion.display} hint={`${d.periodMetrics.closedConversion.numerator}/${d.periodMetrics.closedConversion.denominator}`} />
              <Kpi label="Sotuv summasi (foyda emas)" value={money(d.periodMetrics.salesByCurrency)} />
              <Kpi label="Qabul qilingan to‘lov" value={money(d.periodMetrics.paymentsByCurrency)} hint={`Qaytarim: ${money(d.periodMetrics.refundsByCurrency)}`} />
              <Kpi
                label="Birinchi javob (median / p90)"
                value={`${mins(d.periodMetrics.firstResponse.medianSeconds)} / ${mins(d.periodMetrics.firstResponse.p90Seconds)}`}
                hint={`Kuzatilgan ${d.periodMetrics.firstResponse.observed}, javobsiz ${d.periodMetrics.firstResponse.unanswered}; ish vaqti medianasi ${d.periodMetrics.firstResponse.slaWorkingMinutesMedian ?? '—'} daq`}
              />
            </div>
            <h2>Joriy holat (snapshot, {fmtDateTime(d.snapshot.asOf)})</h2>
            <div className="grid" style={{ margin: '10px 0 18px' }}>
              <Kpi label="Jarayonda" value={d.snapshot.inProgress} />
              <Kpi label="Javob kutilmoqda" value={d.snapshot.awaitingReply} />
            </div>
            <div className="split">
              <Section title="Kunlar bo‘yicha">
                <Bars rows={d.series.map((s) => ({ label: s.bucket, a: s.newLeads, b: s.won }))} />
              </Section>
              <Section title="Voronka (hozirgi holat)">
                <table>
                  <tbody>
                    {Object.entries(STAGE_LABELS).map(([k, v]) => (
                      <tr key={k}>
                        <td>{v}</td>
                        <td>{d.funnel[k] ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h3 className="muted">Manbalar (birinchi manba)</h3>
                {Object.entries(d.periodMetrics.bySource).map(([k, v]) => (
                  <div key={k}>
                    {SOURCE_LABELS[k] ?? k}: <b>{v}</b>
                  </div>
                ))}
              </Section>
            </div>
            <Section title="Menejerlar">
              <p className="muted">{d.notes.managerAttribution}</p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Menejer</th>
                      <th>Yangi lidlar</th>
                      <th>Jarayonda</th>
                      <th>Sotuvlar</th>
                      <th>Konversiya</th>
                      <th>Sotuv summasi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.managers.map((m) => (
                      <tr key={m.userId ?? 'none'}>
                        <td>{m.name}</td>
                        <td>{m.newLeads}</td>
                        <td>{m.inProgress}</td>
                        <td>{m.won}</td>
                        <td>{m.conversion.display}</td>
                        <td>{money(m.salesByCurrency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted">
                <Badge tone="info">CPL/ROAS</Badge> reklama sarfi ma’lumoti ulanmagani uchun hisoblanmaydi. {d.notes.currency}
              </p>
            </Section>
          </>
        )}
      </Async>
    </>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
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
