'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LEAD_STATUS_LABELS, LEAD_STATUS_TONE, SALE_SERVICE_LABELS, SOURCE_GROUP_LABELS, SOURCE_LABELS, fmtDate, fmtDateTime, isoToDmy, parseDmy, sourceGroupOf, statusOfStage, useApi } from '../../../lib/api';
import { Async, Badge, DateInput, Field, InstagramLink } from '../../../components/ui';
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

const REMINDER_LABELS: Record<Departure['reminder']['state'], string> = { off: 'Выключено', scheduled: 'Запланировано', due: 'Пора напомнить', done: 'Выполнено', departed: 'Вылет прошёл' };

/** «Ближайшие вылеты»: 15 будущих вылетов, ближайшие первыми; наступившие напоминания выделены. */
function DeparturesCard({ rows, error }: { rows: Departure[] | null; error: string | null }) {
  return (
    <section className="card panel" aria-label="Ближайшие вылеты">
      <header className="card-head">
        <h2>Ближайшие вылеты</h2>
        <span className="muted">время Ташкента · ближайшие 15</span>
      </header>
      {error && <div className="state error">{error}</div>}
      {rows && rows.length === 0 && <div className="state empty">Ближайших вылетов нет. Дата вылета указывается в блоке «Продажа» карточки лида.</div>}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table className="departures">
            <thead>
              <tr>
                <th>Клиент</th>
                <th>Вылет</th>
                <th>Услуга</th>
                <th>Рейс / маршрут</th>
                <th>Ответственный</th>
                <th>Напоминание</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.orderId} className={r.reminder.state === 'due' ? 'due' : ''}>
                  <td>
                    {r.client}
                    {r.instagramUsername ? (
                      <div>
                        <InstagramLink username={r.instagramUsername} />
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <b>{fmtDateTime(r.departureAt)}</b>
                  </td>
                  <td>{r.serviceType ? (r.serviceType === 'other' && r.soldWhat ? r.soldWhat : SALE_SERVICE_LABELS[r.serviceType]) : '—'}</td>
                  <td>{r.departureNote ?? '—'}</td>
                  <td>{r.owner ?? 'Не назначен'}</td>
                  <td>
                    <Badge tone={r.reminder.state === 'due' ? 'bad' : r.reminder.state === 'scheduled' ? 'info' : 'neutral'}>{REMINDER_LABELS[r.reminder.state]}</Badge>
                    {r.reminder.dueAt && r.reminder.state === 'scheduled' ? <div className="muted">{fmtDateTime(r.reminder.dueAt, r.reminder.timezone)}</div> : null}
                  </td>
                  <td>
                    <Link href={`/leads/${r.leadId}`}>Открыть лид</Link>
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
        <h2>Лиды за период</h2>
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
                <th>Статус</th>
                <th>Ответственный</th>
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
                  <td>{SOURCE_GROUP_LABELS[sourceGroupOf(l.source)]}</td>
                  <td>
                    <Badge tone={LEAD_STATUS_TONE[statusOfStage(l.stage)]}>{LEAD_STATUS_LABELS[statusOfStage(l.stage)]}</Badge>
                  </td>
                  <td>{owner(l.ownerId)}</td>
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
