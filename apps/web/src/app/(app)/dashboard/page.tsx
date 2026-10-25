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

/** Поля себестоимости и прибыли приходят только при праве `finance.cost.view` (иначе `costHidden=true`). */
interface Agg {
  sales: string;
  customerRefunded: string;
  ordersWithRefund: number;
  supplierRefunded?: string;
  /** Первоначальная прибыль: продажа − себестоимость (по заказам с известной себестоимостью). */
  profitBasis?: { sales: string; net: string; profit: string; orders: number; marginPercent: string | null };
  /** После возвратов: (продажа − возвращено клиенту) − (себестоимость − возвращено поставщиком). */
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

/** Сегодняшняя дата в часовом поясе компании (Asia/Tashkent), а не в поясе браузера/UTC. */
const tashkentToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
const mins = (s: number | null) => (s === null ? '—' : `${Math.round(s / 60)} мин.`);
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
  // Черновик (значения в полях) и применённый фильтр раздельны: результаты обновляются только по кнопке «Найти».
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
    if (!f || !t) return setFilterError('Введите дату в формате ДД.ММ.ГГГГ (например, 25.10.2026).');
    if (f > t) return setFilterError('Дата начала не может быть позже даты окончания.');
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
          <h1>Панель управления</h1>
          <p className="muted">
            {fmtDate(applied.from)} – {fmtDate(applied.to)}
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
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Лид, клиент, телефон, @username…" aria-label="Поиск лида" />
        </form>
        <Link href="/notifications" className="iconbtn" aria-label={`Уведомления${unread ? `: непрочитанных ${unread}` : ''}`}>
          <Icon name="bell" size={20} />
          {unread > 0 && <span className="dot" aria-hidden="true" />}
        </Link>
      </header>

      <section className="filter-card" aria-label="Фильтры">
        <Field label="Начало (Asia/Tashkent)">
          <DateInput value={from} onChange={setFrom} label="Дата начала (ДД.ММ.ГГГГ)" />
        </Field>
        <Field label="Конец (включительно)">
          <DateInput value={to} onChange={setTo} label="Дата окончания (ДД.ММ.ГГГГ)" />
        </Field>
        <Field label="Источник">
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Все</option>
            {Object.entries(SOURCE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Туроператор">
          <select value={operator} onChange={(e) => setOperator(e.target.value)}>
            <option value="">Все</option>
            {(operators.data?.items ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.status === 'archived' ? ' (архив)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Валюта">
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="">Все</option>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Группировка">
          <select value={bucket} onChange={(e) => setBucket(e.target.value)}>
            <option value="day">По дням</option>
            <option value="week">По неделям</option>
            <option value="month">По месяцам</option>
          </select>
        </Field>
        <div className="filter-actions" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <button className="btn" type="button" onClick={apply}>
            Найти
          </button>
          <button className="btn secondary" type="button" onClick={clear}>
            Сбросить
          </button>
        </div>
        {canDo(me, 'export') && (
          <a className="btn secondary with-icon" href={`/api/v1/exports/leads.csv?${q}`}>
            <Icon name="download" size={16} />
            Экспорт лидов (CSV)
          </a>
        )}
        {canDo(me, 'export') && (
          <a className="btn secondary with-icon" href={`/api/v1/exports/orders.csv?${q}`}>
            <Icon name="download" size={16} />
            Экспорт заказов (CSV, прибыль)
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
                <Stat icon="leads" label="Новые лиды" value={pm.newLeads} note={`Уникальных обращений: ${pm.inquiries}`} />
                <Stat icon="chart" label="Конверсия когорты" value={pm.cohortConversion.display} note={`${pm.cohortConversion.numerator}/${pm.cohortConversion.denominator} лидов → продажа`} />
                <Stat icon="wallet" label="Сумма продаж (не прибыль)" value={money(pm.salesByCurrency)} note={`Получено платежей: ${money(pm.paymentsByCurrency)}`} />
                <Stat icon="clock" label="Первый ответ (медиана / p90)" value={`${mins(fr.medianSeconds)} / ${mins(fr.p90Seconds)}`} note={`Наблюдений ${fr.observed}, без ответа ${fr.unanswered}`} />
              </div>

              <FinanceBlock f={d.finance} />

              <div className="dash-grid">
                <section className="card panel">
                  <header className="card-head">
                    <h2>Воронка продаж</h2>
                    <span className="muted">текущее состояние · {fmtDateTime(d.snapshot.asOf)}</span>
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
                    <h2>Менеджеры</h2>
                    <span className="muted">выбранный период</span>
                  </header>
                  <div className="mgr-head" aria-hidden="true">
                    <span>Менеджер</span>
                    <span>Лиды</span>
                    <span>Конв.</span>
                    <span>Сумма</span>
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
                            {m.won} продаж · {m.inProgress} в работе
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

              <h2 className="section-title">Дополнительные показатели</h2>
              <p className="muted">
                Полный сбор данных начался: {fmtDateTime(d.dataQuality.dataCollectionStartedAt)}
              </p>
              <div className="grid" style={{ margin: '10px 0 18px' }}>
                <Kpi label="Обращения (уникальные)" value={pm.inquiries} />
                <Kpi label="Лиды из рекламы" value={pm.adsLeads} />
                <Kpi label="Лиды из Direct" value={pm.directLeads} />
                <Kpi label="Обработано" value={pm.processed} />
                <Kpi label="Успешные продажи" value={pm.won} />
                <Kpi label="Отменённые лиды" value={pm.lost} />
                <Kpi label="Отменённые заказы" value={pm.cancelledOrders} />
                <Kpi label="Конверсия закрытых" value={pm.closedConversion.display} hint={`${pm.closedConversion.numerator}/${pm.closedConversion.denominator}`} />
                <Kpi label="Возвраты" value={money(pm.refundsByCurrency)} />
                <Kpi label="Первый ответ в рабочее время (медиана)" value={fr.slaWorkingMinutesMedian === null ? '—' : `${fr.slaWorkingMinutesMedian} мин.`} />
                <Kpi label="В работе (срез)" value={d.snapshot.inProgress} />
                <Kpi label="Ожидают ответа (срез)" value={d.snapshot.awaitingReply} />
              </div>

              <div className="split">
                <section className="card panel">
                  <header className="card-head">
                    <h2>Динамика</h2>
                  </header>
                  <Bars rows={d.series.map((s) => ({ label: s.bucket, a: s.newLeads, b: s.won }))} />
                </section>
                <section className="card panel">
                  <header className="card-head">
                    <h2>Источники</h2>
                  </header>
                  {Object.entries(pm.bySource).map(([k, v]) => (
                    <div key={k} className="source-row">
                      <span>{SOURCE_LABELS[k] ?? k}</span>
                      <b>{v}</b>
                    </div>
                  ))}
                  <p className="muted">
                    <Badge tone="info">CPL/ROAS</Badge> не считаются: данные о рекламных расходах не подключены. {d.notes.currency}
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

/** Лиды по фильтру (по дате создания): загрузка, ошибка и пустой результат показываются отдельно; результат прошлого периода не сохраняется. */
function DashLeads({ query }: { query: string }) {
  const res = useApi<{ total: number; truncated: boolean; items: DashLead[] }>(`/api/v1/dashboard/leads?${query}`, { reset: true });
  const team = useApi<{ items: Array<{ id: string; fullName: string }> }>('/api/v1/team');
  const owner = (id: string | null) => team.data?.items.find((u) => u.id === id)?.fullName ?? (id ? '—' : 'Не назначен');
  return (
    <section className="card panel" aria-label="Лиды по фильтру">
      <header className="card-head">
        <h2>Лиды по фильтру</h2>
        <span className="muted">{res.data ? `Найдено лидов: ${res.data.total}${res.data.truncated ? ` (показаны первые ${res.data.items.length})` : ''}` : ''}</span>
      </header>
      {res.loading && !res.data && <div className="state">Загрузка…</div>}
      {res.error && !res.data && (
        <div className="state error" role="alert">
          Ошибка запроса: {res.error.message}{' '}
          <button className="btn secondary" type="button" onClick={() => void res.reload()}>
            Повторить
          </button>
        </div>
      )}
      {res.data && res.data.items.length === 0 && <div className="state empty">За выбранный период данных нет</div>}
      {res.data && res.data.items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Клиент / @username</th>
                <th>Источник</th>
                <th>Ответственный</th>
                <th>Этап</th>
                <th>Создан</th>
                <th>Карточка</th>
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

/** Прибыль: если нет заказов с известной себестоимостью — «Не определена» (не 0); при частичных данных — со значком. */
function ProfitText({ a, c }: { a: Agg; c: string }) {
  if (!a.profitBasis || a.profitBasis.orders === 0) return <Badge tone="warn">Не определена</Badge>;
  return (
    <>
      <b className={a.profitBasis.profit.startsWith('-') ? 'neg' : 'pos'}>{money({ [c]: a.profitBasis.profit })}</b>
      {a.afterRefund && a.ordersWithRefund > 0 && (
        <div className="muted">
          после возвратов: <b className={a.afterRefund.profit.startsWith('-') ? 'neg' : 'pos'}>{money({ [c]: a.afterRefund.profit })}</b>
        </div>
      )}
      {a.undetermined && a.undetermined.orders > 0 && <span className="muted" title="Заказы без указанной себестоимости в прибыль не входят"> *</span>}
    </>
  );
}
const profitCls = (v: string) => (isNeg(v) ? 'neg' : 'pos');
const sel = (m: Record<string, unknown>) => Object.keys(m);

/** Подтверждённые продажи: продажа / себестоимость / прибыль (валюты отдельно), ожидаемая прибыль и разрезы. */
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
    <section className="finance-block" aria-label="Финансовые показатели">
      <div className="card panel">
        <header className="card-head">
          <h2>{cost ? 'Финансы: продажи, себестоимость и прибыль' : 'Финансы: продажи и возвраты'}</h2>
          <span className="muted">подтверждённые продажи · валюты отдельно</span>
        </header>
        {!cost && <p className="muted">Себестоимость и прибыль не отображаются: нужно отдельное разрешение.</p>}
        {ccys.length === 0 ? (
          <div className="state empty">За выбранный период подтверждённых (закрытых) продаж нет.</div>
        ) : (
          ccys.map((c) => {
            const a = f.confirmed[c]!;
            const pb = a.profitBasis;
            return (
              <div key={c} className="fin-ccy">
                <h3 className="fin-ccy-title">{c}</h3>
                <div className="stat-row">
                  <div className="stat">
                    <div className="stat-label">Общая сумма продаж</div>
                    <div className="stat-value">{fmtAmount(a.sales)} <small>{CURRENCY_LABEL[c] ?? c}</small></div>
                    <div className="stat-note">все подтверждённые заказы</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Возвращено клиенту</div>
                    <div className="stat-value">{fmtAmount(a.customerRefunded)} <small>{CURRENCY_LABEL[c] ?? c}</small></div>
                    <div className="stat-note">заказов с возвратом: {a.ordersWithRefund}</div>
                  </div>
                  {cost && pb && (
                    <>
                      <div className="stat">
                        <div className="stat-label">Общая себестоимость</div>
                        {pb.orders === 0 ? <div className="stat-value">—</div> : <div className="stat-value">{fmtAmount(pb.net)} <small>{CURRENCY_LABEL[c] ?? c}</small></div>}
                        <div className="stat-note">{pb.orders === 0 ? 'нет заказов с известной себестоимостью' : `по заказам с известной себестоимостью: ${pb.orders}`}</div>
                      </div>
                      <div className="stat">
                        <div className="stat-label">Первоначальная прибыль</div>
                        {pb.orders === 0 ? (
                          <div className="stat-value">
                            <Badge tone="warn">Не определена</Badge>
                          </div>
                        ) : (
                          <div className={`stat-value ${profitCls(pb.profit)}`}>{fmtAmount(pb.profit)} <small>{CURRENCY_LABEL[c] ?? c}</small></div>
                        )}
                        <div className="stat-note">
                          {pb.orders === 0 ? 'не считается, пока не указана себестоимость' : `продажа ${fmtAmount(pb.sales)} − себестоимость ${fmtAmount(pb.net)}`}
                          {pb.orders > 0 && pb.marginPercent !== null && ` · маржа ${pb.marginPercent.replace('.', ',')}%`}
                        </div>
                      </div>
                      <div className="stat">
                        <div className="stat-label">Возвращено поставщиком</div>
                        <div className="stat-value">{fmtAmount(a.supplierRefunded ?? '0.00')} <small>{CURRENCY_LABEL[c] ?? c}</small></div>
                        <div className="stat-note">возврат себестоимости (отдельно от возврата клиенту)</div>
                      </div>
                      <div className="stat">
                        <div className="stat-label">Прибыль после возвратов</div>
                        {pb.orders === 0 || !a.afterRefund ? (
                          <div className="stat-value">
                            <Badge tone="warn">Не определена</Badge>
                          </div>
                        ) : (
                          <div className={`stat-value ${profitCls(a.afterRefund.profit)}`}>{fmtAmount(a.afterRefund.profit)} <small>{CURRENCY_LABEL[c] ?? c}</small></div>
                        )}
                        <div className="stat-note">{a.afterRefund ? `(${fmtAmount(a.afterRefund.sales)}) − (${fmtAmount(a.afterRefund.net)})` : 'не считается, пока не указана себестоимость'}</div>
                      </div>
                      <div className="stat">
                        <div className="stat-label">Прибыль не определена</div>
                        <div className="stat-value">{a.undetermined?.orders ?? 0} <small>заказов</small></div>
                        <div className="stat-note">себестоимость не указана; продажи {fmtAmount(a.undetermined?.sales ?? '0.00')} {CURRENCY_LABEL[c] ?? c} в прибыль не входят и не считаются за 0</div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
        {f.unpricedOrders > 0 && <p className="hint">Подтверждённых заказов без цены: {f.unpricedOrders}.</p>}
        {cost && !!f.refundMismatchOrders && <div className="state error">В заказах с несовпадением валюты возврата и цены: {f.refundMismatchOrders} — их прибыль после возвратов не рассчитана.</div>}
        <div className="fin-extra">
          {cost && (
            <div>
              <b>Ожидаемая прибыль</b> <span className="muted">(открытые заказы, не подтверждены)</span>
              {sel(f.expected).length === 0 ? (
                <div className="muted">—</div>
              ) : (
                sel(f.expected).map((c) => (
                  <div key={c}>
                    <b className={profitCls(f.expected[c]!.profit)}>{money({ [c]: f.expected[c]!.profit })}</b> <span className="muted">· заказов: {f.expected[c]!.orders}{f.expected[c]!.undeterminedOrders ? `, без себестоимости: ${f.expected[c]!.undeterminedOrders}` : ''}</span>
                  </div>
                ))
              )}
            </div>
          )}
          <div>
            <b>Отменённые заказы</b> <span className="muted">(в итог не входят, хранятся в истории)</span>
            {sel(f.cancelled).length === 0 ? <div className="muted">—</div> : sel(f.cancelled).map((c) => <div key={c}>{money({ [c]: f.cancelled[c]!.sales })} <span className="muted">· {f.cancelled[c]!.orders} шт.</span></div>)}
          </div>
        </div>
        <details className="fin-rules">
          <summary>Правила расчёта</summary>
          <ul>
            {cost && (
              <>
                <li>
                  <b>Первоначальная прибыль = цена продажи − себестоимость.</b>
                </li>
                <li>
                  <b>Прибыль после возвратов = (продажа − возвращено клиенту) − (себестоимость − возвращено поставщиком).</b>
                </li>
                <li>Дополнительные расходы не учтены: это не итоговая «чистая прибыль» по бухгалтерии.</li>
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
            <h2>По туроператорам</h2>
            <span className="muted">{cost ? 'продажи и прибыль (туроператор — историческая связь заказа)' : 'продажи'}</span>
          </header>
          {f.byOperator.length === 0 ? (
            <div className="state empty">Нет данных</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Туроператор</th>
                    <th>Заказы</th>
                    <th>Продажи</th>
                    {cost && <th>Прибыль</th>}
                  </tr>
                </thead>
                <tbody>
                  {f.byOperator.map((r) => (
                    <tr key={r.operatorId ?? 'none'}>
                      <td>
                        <b>{r.name}</b>
                        {cost && !!r.undeterminedOrders && <div className="muted">прибыль не определена: {r.undeterminedOrders} шт.</div>}
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
            <h2>По менеджерам</h2>
            <span className="muted">{cost ? 'продажи и прибыль (ответственный на момент закрытия)' : 'продажи (ответственный на момент закрытия)'}</span>
          </header>
          {f.byManager.length === 0 ? (
            <div className="state empty">Нет данных</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Менеджер</th>
                    <th>Заказы</th>
                    <th>Продажи</th>
                    {cost && <th>Прибыль</th>}
                  </tr>
                </thead>
                <tbody>
                  {f.byManager.map((r) => (
                    <tr key={r.userId ?? 'none'}>
                      <td>
                        <b>{r.name}</b>
                        {cost && !!r.undeterminedOrders && <div className="muted">прибыль не определена: {r.undeterminedOrders} шт.</div>}
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
  // Если данные о рейсах недоступны для роли (403) или ещё не загружены, блок не показывается.
  if (!state.data) return null;
  const rows = state.data.items.slice(0, 5);
  return (
    <section className="card panel">
      <header className="card-head">
        <h2>Ближайшие рейсы</h2>
        <span className="legend" aria-label="Обозначения цветов">
          <span>
            <i className="sw brand" />
            Фирменный акцент
          </span>
          <span>
            <i className="sw bad" />
            Нужна проверка
          </span>
          <span>
            <i className="sw cancel" />
            Отменён
          </span>
        </span>
      </header>
      {rows.length === 0 ? (
        <div className="state empty">Ближайших рейсов нет</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Рейс</th>
                <th>Маршрут</th>
                <th>Вылет</th>
                <th>Клиент</th>
                <th>Ответственный</th>
                <th>Осталось</th>
                <th>Статус</th>
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
  if (s.operationalStatus === 'cancelled') return { tone: 'cancel', icon: 'x', label: 'Отменён', cancelled: true };
  if (s.operationalStatus === 'schedule_changed') return { tone: 'warn', icon: 'clock', label: 'Время изменилось', cancelled: false };
  if (s.checkState === 'due' || s.checkState === 'recheck_required') return { tone: 'bad', icon: 'alert', label: 'Нужна проверка', cancelled: false };
  if (s.checkState === 'checked') return { tone: 'ok', icon: 'check', label: 'Проверен', cancelled: false };
  return { tone: 'neutral', icon: 'clock', label: 'Ожидает', cancelled: false };
}

function timeLeft(utc: string | null): string {
  if (!utc) return '—';
  const ms = new Date(utc).getTime() - Date.now();
  if (ms <= 0) return '—';
  const h = Math.floor(ms / 3_600_000);
  return h >= 24 ? `${Math.floor(h / 24)} дн.` : `${h} ч.`;
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
  if (!rows.length) return <div className="state empty">За выбранный период лидов нет</div>;
  return (
    <div role="table" aria-label="Новые лиды и продажи">
      {rows.map((r) => (
        <div key={r.label} role="row" style={{ display: 'grid', gridTemplateColumns: '90px 1fr 70px', gap: 8, alignItems: 'center', marginBottom: 4 }}>
          <span role="cell" className="muted">
            {r.label}
          </span>
          <span role="cell">
            <div className="bar" style={{ width: `${(r.a / max) * 100}%` }} />
          </span>
          <span role="cell">
            {r.a} / {r.b} продаж
          </span>
        </div>
      ))}
    </div>
  );
}
