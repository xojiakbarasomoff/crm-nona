'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type MouseEvent } from 'react';
import { LEAD_STATUS_LABELS, LEAD_STATUS_TONE, SALE_SERVICE_LABELS, SOURCE_GROUP_LABELS, SOURCE_LABELS, fmtDate, fmtDateTime, isoToDmy, parseDmy, sourceGroupOf, statusOfStage, useApi } from '../../../lib/api';
import { Async, Badge, DateInput, Field, InstagramIconLink, Initials, TargetBadge } from '../../../components/ui';
import { Icon, type IconName } from '../../../components/icons';
import { money } from '../../../lib/format';
import { canDo, useMe } from '../../../components/shell';

/** Поля себестоимости и прибыли приходят только при праве `finance.cost.view` (иначе `costHidden=true`). */
interface Agg {
  sales: string;
  profitBasis?: { sales: string; net: string; profit: string; orders: number; marginPercent: string | null };
  undetermined?: { orders: number; sales: string };
}
interface Dash {
  period: { from: string; to: string; timezone: string };
  periodMetrics: { newLeads: number; won: number; lost: number };
  finance: { costHidden: boolean; confirmed: Record<string, Agg> };
}

interface Departure {
  orderId: string;
  leadId: string;
  client: string;
  instagramUsername: string | null;
  departureAt: string;
  serviceType: string | null;
  soldWhat: string | null;
  departureNote: string | null;
  owner: string | null;
  reminder: { state: 'off' | 'scheduled' | 'due' | 'done' | 'departed'; dueAt: string | null; timezone: string };
}

/** Сегодняшняя дата в часовом поясе компании (Asia/Tashkent), а не в поясе браузера/UTC. */
const tashkentToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
const DASH_SOURCES = ['instagram_direct', 'instagram_lead_ads', 'meta_lead_ads', 'manual'];

export default function DashboardPage() {
  const me = useMe();
  const router = useRouter();
  const defaults = () => ({ from: `${tashkentToday().slice(0, 8)}01`, to: tashkentToday(), source: '' });
  // Черновик (значения в полях) и применённый фильтр раздельны: результаты обновляются только по кнопке «Найти».
  const [from, setFrom] = useState(() => isoToDmy(defaults().from));
  const [to, setTo] = useState(() => isoToDmy(defaults().to));
  const [source, setSource] = useState('');
  const [applied, setApplied] = useState(defaults);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const apply = () => {
    const f = parseDmy(from);
    const t = parseDmy(to);
    if (!f || !t) return setFilterError('Введите дату в формате ДД.ММ.ГГГГ (например, 25.10.2026).');
    if (f > t) return setFilterError('Дата начала не может быть позже даты окончания.');
    setFilterError(null);
    setApplied({ from: f, to: t, source });
  };
  const clear = () => {
    const d = defaults();
    setFrom(isoToDmy(d.from));
    setTo(isoToDmy(d.to));
    setSource('');
    setFilterError(null);
    setApplied(d);
  };
  const q = new URLSearchParams({ from: applied.from, to: applied.to, bucket: 'day', ...(applied.source ? { source: applied.source } : {}) });
  const state = useApi<Dash>(`/api/v1/dashboard?${q}`, { reset: true });
  const departures = useApi<{ items: Departure[] }>('/api/v1/dashboard/departures', { pollMs: 60_000 });
  const notifications = useApi<{ items: Array<{ id: string; readAt: string | null }> }>('/api/v1/notifications');
  const unread = notifications.data?.items.filter((n) => !n.readAt).length ?? 0;

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

      <DeparturesCard rows={departures.data?.items ?? null} error={departures.error?.message ?? null} />

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
            {DASH_SOURCES.map((k) => (
              <option key={k} value={k}>
                {SOURCE_GROUP_LABELS[sourceGroupOf(k)]}
                {sourceGroupOf(k) === 'ADS' ? ` · ${SOURCE_LABELS[k]}` : ''}
              </option>
            ))}
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
      </section>
      {filterError && (
        <div className="state error" role="alert">
          {filterError}
        </div>
      )}

      <Async state={state}>
        {(d) => {
          const ccys = Object.keys(d.finance.confirmed);
          const sales = Object.fromEntries(ccys.map((c) => [c, d.finance.confirmed[c]!.sales]));
          const profitKnown = ccys.filter((c) => (d.finance.confirmed[c]!.profitBasis?.orders ?? 0) > 0);
          const profit = Object.fromEntries(profitKnown.map((c) => [c, d.finance.confirmed[c]!.profitBasis!.profit]));
          const partial = ccys.some((c) => (d.finance.confirmed[c]!.undetermined?.orders ?? 0) > 0);
          return (
            <div className="stat-row">
              <Stat icon="leads" label="Лиды" value={d.periodMetrics.newLeads} note={`Продано: ${d.periodMetrics.won} · Отменено: ${d.periodMetrics.lost}`} />
              <Stat icon="wallet" label="Сумма продаж" value={money(sales)} note="Каждая валюта отдельно, без пересчёта по курсу" />
              {!d.finance.costHidden && (
                <Stat
                  icon="chart"
                  label="Прибыль"
                  value={profitKnown.length ? money(profit) : 'Не определена'}
                  note={partial ? 'Продажи без себестоимости в прибыль не входят' : 'Цена продажи − Себестоимость'}
                />
              )}
            </div>
          );
        }}
      </Async>
      <DashLeads query={q.toString()} />
    </>
  );
}

const REMINDER_LABELS: Record<Departure['reminder']['state'], string> = { off: 'Не включено', scheduled: 'Запланировано', due: 'Пора проверить вылет', done: 'Выполнено', departed: 'Вылет прошёл' };

/** «через 2 дн. 5 ч» — сколько осталось до вылета. */
function timeLeft(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'вылет наступил';
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  if (d >= 1) return `через ${d} дн.${h % 24 ? ` ${h % 24} ч` : ''}`;
  if (h >= 1) return `через ${h} ч`;
  return `через ${Math.max(1, Math.round(ms / 60_000))} мин.`;
}

/** Напоминание наступило (по сохранённому времени: 3 дня до вылета или своё), а вылет ещё впереди. */
const isUrgent = (r: Departure) => r.reminder.state === 'due' || (r.reminder.state === 'scheduled' && !!r.reminder.dueAt && new Date(r.reminder.dueAt).getTime() <= Date.now());

/** «Ближайшие вылеты»: 15 будущих вылетов по времени вылета (не по дате создания лида и не по фильтру отчёта). */
function DeparturesCard({ rows, error }: { rows: Departure[] | null; error: string | null }) {
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const urgentCount = rows?.filter(isUrgent).length ?? 0;
  return (
    <section className="card table-card departures-card" aria-label="Ближайшие вылеты">
      <header className="card-head table-card-head">
        <h2>Ближайшие вылеты</h2>
        <span className="muted">
          {urgentCount > 0 ? <b className="urgent-count">Пора проверить: {urgentCount} · </b> : null}
          ближайшие 15 · время Ташкента
        </span>
      </header>
      {error && <div className="state error table-card-state">{error}</div>}
      {rows && rows.length === 0 && <div className="state empty table-card-state">Ближайших вылетов пока нет. Дата и время вылета указываются в блоке «Продажа» карточки лида.</div>}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table className="leads-table departures">
            <thead>
              <tr>
                <th>Клиент</th>
                <th>Вылет</th>
                <th>Осталось</th>
                <th>Рейс / маршрут</th>
                <th>Ответственный</th>
                <th>Напоминание</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const urgent = isUrgent(r);
                const name = r.client && r.client !== 'Instagram mijoz' ? r.client : r.instagramUsername ? `@${r.instagramUsername}` : 'Клиент';
                const service = r.serviceType ? (r.serviceType === 'other' && r.soldWhat ? r.soldWhat : SALE_SERVICE_LABELS[r.serviceType]) : null;
                return (
                  <tr
                    key={r.orderId}
                    className={`lead-row${urgent ? ' urgent' : ''}`}
                    onClick={(e: MouseEvent) => {
                      if (!(e.target as HTMLElement).closest('a, button')) router.push(`/leads/${r.leadId}`);
                    }}
                  >
                    <td>
                      <div className="lead-cell">
                        <Initials name={name} />
                        <div className="lead-cell-text">
                          <Link href={`/leads/${r.leadId}`} className="lead-name">
                            {name}
                          </Link>
                          {r.instagramUsername && name !== `@${r.instagramUsername}` ? <div className="lead-sub">@{r.instagramUsername}</div> : null}
                        </div>
                        {r.instagramUsername && <InstagramIconLink username={r.instagramUsername} />}
                      </div>
                    </td>
                    <td className="nowrap">
                      <b>{fmtDateTime(r.departureAt)}</b>
                    </td>
                    <td className="nowrap">{timeLeft(r.departureAt, now)}</td>
                    <td>
                      {r.departureNote ?? '—'}
                      {service ? <div className="lead-sub">{service}</div> : null}
                    </td>
                    <td>{r.owner ?? 'Не назначен'}</td>
                    <td>
                      {urgent ? (
                        <span className="urgent-flag">
                          <Icon name="alert" size={14} />
                          Пора проверить вылет
                        </span>
                      ) : (
                        <Badge tone={r.reminder.state === 'scheduled' ? 'info' : 'neutral'}>{REMINDER_LABELS[r.reminder.state]}</Badge>
                      )}
                      {r.reminder.dueAt && !urgent && r.reminder.state === 'scheduled' ? <div className="lead-sub">{fmtDateTime(r.reminder.dueAt, r.reminder.timezone)}</div> : null}
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
  fromAd: boolean;
}

/** Лиды по фильтру (по дате создания): загрузка, ошибка и пустой результат показываются отдельно; результат прошлого периода не сохраняется. */
function DashLeads({ query }: { query: string }) {
  const router = useRouter();
  // «Только из рекламы» сужает только эту таблицу (вместе с периодом и фильтрами отчёта); KPI не меняются.
  const [fromAd, setFromAd] = useState(false);
  const res = useApi<{ total: number; truncated: boolean; items: DashLead[] }>(`/api/v1/dashboard/leads?${query}${fromAd ? '&fromAd=true' : ''}`, { reset: true });
  const team = useApi<{ items: Array<{ id: string; fullName: string }> }>('/api/v1/team');
  const owner = (id: string | null) => team.data?.items.find((u) => u.id === id)?.fullName ?? (id ? '—' : 'Не назначен');
  return (
    <section className="card table-card" aria-label="Лиды за период">
      <header className="card-head table-card-head">
        <h2>Лиды за период</h2>
        <label className="check-filter">
          <input type="checkbox" checked={fromAd} onChange={(e) => setFromAd(e.target.checked)} />
          Только из рекламы
        </label>
        <span className="muted">{res.data ? `Найдено лидов: ${res.data.total}${res.data.truncated ? ` (показаны первые ${res.data.items.length})` : ''}` : ''}</span>
      </header>
      {res.loading && !res.data && <div className="state table-card-state">Загрузка…</div>}
      {res.error && !res.data && (
        <div className="state error table-card-state" role="alert">
          Ошибка запроса: {res.error.message}{' '}
          <button className="btn secondary" type="button" onClick={() => void res.reload()}>
            Повторить
          </button>
        </div>
      )}
      {res.data && res.data.items.length === 0 && <div className="state empty table-card-state">За выбранный период данных нет</div>}
      {res.data && res.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="leads-table">
            <thead>
              <tr>
                <th>Клиент</th>
                <th>Статус</th>
                <th>Источник</th>
                <th>Ответственный</th>
                <th>Создан</th>
              </tr>
            </thead>
            <tbody>
              {res.data.items.map((l) => {
                const st = statusOfStage(l.stage);
                const handle = l.instagramUsername ? `@${l.instagramUsername}` : null;
                const name = l.contactName && l.contactName !== 'Instagram mijoz' ? l.contactName : (handle ?? l.name);
                const sub = [handle && handle !== name ? handle : null, l.telegramUsername ? `Telegram @${l.telegramUsername}` : null].filter(Boolean).join(' · ');
                return (
                  <tr
                    key={l.id}
                    className="lead-row"
                    onClick={(e: MouseEvent) => {
                      if (!(e.target as HTMLElement).closest('a, button')) router.push(`/leads/${l.id}`);
                    }}
                  >
                    <td>
                      <div className="lead-cell">
                        <Initials name={name} />
                        <div className="lead-cell-text">
                          <Link href={`/leads/${l.id}`} className="lead-name">
                            {name}
                          </Link>
                          {sub ? <div className="lead-sub">{sub}</div> : null}
                        </div>
                        {l.instagramUsername && <InstagramIconLink username={l.instagramUsername} />}
                        <TargetBadge show={l.fromAd} />
                      </div>
                    </td>
                    <td>
                      <Badge tone={LEAD_STATUS_TONE[st]} className="status">
                        {LEAD_STATUS_LABELS[st]}
                      </Badge>
                    </td>
                    <td>{SOURCE_GROUP_LABELS[sourceGroupOf(l.source)]}</td>
                    <td>{owner(l.ownerId)}</td>
                    <td className="nowrap">{fmtDateTime(l.createdAt)}</td>
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
