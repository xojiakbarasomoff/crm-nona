'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type MouseEvent } from 'react';
import { LEAD_STATUS_LABELS, LEAD_STATUS_TONE, LEAD_TYPE_LABELS, SOURCE_GROUP_LABELS, fmtDateTime, rememberLeadsQuery, sourceGroupOf, statusOfStage, useApi } from '../../../lib/api';
import { Async, Badge, Field, InstagramIconLink, Initials } from '../../../components/ui';
import { NewLeadForm } from '../../../components/manual-lead';

interface LeadRow {
  id: string;
  name: string;
  stage: string;
  leadType: string;
  firstSource: string;
  createdAt: string;
  ownerId: string | null;
  slaBreachedAt: string | null;
  firstHumanActionAt: string | null;
  contactInstagramUsername: string | null;
}

const FILTER_KEYS = ['status', 'sourceGroup', 'leadType', 'search'] as const;
type Filters = Record<(typeof FILTER_KEYS)[number], string>;
const EMPTY: Filters = { status: '', sourceGroup: '', leadType: '', search: '' };

export default function LeadsPage() {
  const router = useRouter();
  // Фильтры живут в адресе (/leads?status=…): возврат из карточки и обновление страницы их не сбрасывают.
  const [f, setF] = useState<Filters | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setF(Object.fromEntries(FILTER_KEYS.map((k) => [k, p.get(k) ?? ''])) as Filters);
  }, []);
  const filterQs = f ? new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString() : '';
  useEffect(() => {
    if (!f) return;
    window.history.replaceState(window.history.state, '', `/leads${filterQs ? `?${filterQs}` : ''}`);
    rememberLeadsQuery(filterQs);
  }, [f, filterQs]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const set = (k: keyof Filters, v: string) => {
    setCursor(undefined);
    setF((s) => ({ ...(s ?? EMPTY), [k]: v }));
  };
  const q = new URLSearchParams({ limit: '50', ...Object.fromEntries(Object.entries(f ?? {}).filter(([, v]) => v)), ...(cursor ? { cursor } : {}) });
  const state = useApi<{ items: LeadRow[]; nextCursor: string | null }>(f ? `/api/v1/leads?${q}` : null);
  const team = useApi<{ items: Array<{ id: string; fullName: string }> }>('/api/v1/team');
  const name = (id: string | null) => team.data?.items.find((u) => u.id === id)?.fullName ?? (id ? '—' : 'Не назначен');
  // Вся строка открывает карточку; ссылки внутри строки (Instagram) работают сами по себе.
  const openRow = (e: MouseEvent, id: string) => {
    if ((e.target as HTMLElement).closest('a, button')) return;
    router.push(`/leads/${id}`);
  };

  return (
    <>
      <div className="page-title-row">
        <h1>Лиды</h1>
        <button className="btn" type="button" onClick={() => setCreating((v) => !v)}>
          + Создать лид
        </button>
      </div>
      {creating && <NewLeadForm onClose={() => setCreating(false)} />}
      <section className="card filters" aria-label="Фильтры">
        {(
          [
            ['status', 'Статус', LEAD_STATUS_LABELS],
            ['sourceGroup', 'Источник', SOURCE_GROUP_LABELS],
            ['leadType', 'Тип лида', LEAD_TYPE_LABELS],
          ] as const
        ).map(([key, label, labels]) => (
          <Field key={key} label={label}>
            <select value={f?.[key] ?? ''} onChange={(e) => set(key, e.target.value)}>
              <option value="">Все</option>
              {Object.entries(labels).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        ))}
        <Field label="Поиск">
          <input type="search" value={f?.search ?? ''} onChange={(e) => set('search', e.target.value)} placeholder="Имя, телефон или @username" />
        </Field>
      </section>
      <Async state={state} isEmpty={(d) => d.items.length === 0}>
        {(d) => (
          <div className="card table-card">
            <div className="table-wrap">
              <table className="leads-table">
                <thead>
                  <tr>
                    <th>Клиент</th>
                    <th>Статус</th>
                    <th>Источник</th>
                    <th>Тип</th>
                    <th>Ответственный</th>
                    <th>Создан</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((l) => {
                    const st = statusOfStage(l.stage);
                    const ig = l.contactInstagramUsername;
                    const handle = ig ? `@${ig}` : null;
                    const sla = l.slaBreachedAt && !l.firstHumanActionAt;
                    return (
                      <tr key={l.id} className="lead-row" onClick={(e) => openRow(e, l.id)}>
                        <td>
                          <div className="lead-cell">
                            <Initials name={l.name} />
                            <div className="lead-cell-text">
                              <Link href={`/leads/${l.id}`} className="lead-name">
                                {l.name}
                              </Link>
                              {((handle && l.name !== handle) || sla) && (
                                <div className="lead-sub">
                                  {handle && l.name !== handle ? <span>{handle}</span> : null}
                                  {sla ? <span className="sla-flag">Срок ответа нарушен</span> : null}
                                </div>
                              )}
                            </div>
                            {ig && <InstagramIconLink username={ig} />}
                          </div>
                        </td>
                        <td>
                          <Badge tone={LEAD_STATUS_TONE[st]} className="status">
                            {LEAD_STATUS_LABELS[st]}
                          </Badge>
                        </td>
                        <td>{SOURCE_GROUP_LABELS[sourceGroupOf(l.firstSource)]}</td>
                        <td>{LEAD_TYPE_LABELS[l.leadType] ?? '—'}</td>
                        <td>{name(l.ownerId)}</td>
                        <td className="nowrap">{fmtDateTime(l.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {d.nextCursor && (
              <div className="card-foot">
                <button className="btn secondary" type="button" onClick={() => setCursor(d.nextCursor!)}>
                  Следующая страница
                </button>
              </div>
            )}
          </div>
        )}
      </Async>
    </>
  );
}
