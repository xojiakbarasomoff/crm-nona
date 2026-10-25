'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LEAD_STATUS_LABELS, LEAD_STATUS_TONE, LEAD_TYPE_LABELS, SOURCE_GROUP_LABELS, fmtDateTime, sourceGroupOf, statusOfStage, useApi } from '../../../lib/api';
import { Async, Badge, Field, InstagramLink, Section } from '../../../components/ui';
import { NewLeadForm } from '../../../components/manual-lead';

interface LeadRow {
  id: string;
  name: string;
  stage: string;
  leadType: string;
  firstSource: string;
  createdAt: string;
  ownerId: string | null;
  anomaly: unknown;
  slaBreachedAt: string | null;
  firstHumanActionAt: string | null;
  contactInstagramUsername: string | null;
}

export default function LeadsPage() {
  const [status, setStatus] = useState('');
  const [sourceGroup, setSourceGroup] = useState('');
  const [leadType, setLeadType] = useState('');
  const [search, setSearch] = useState('');
  // Поиск с панели управления приходит как /leads?search=... (читается один раз).
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('search');
    if (s) setSearch(s);
  }, []);
  const [cursor, setCursor] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const q = new URLSearchParams({ limit: '50', ...(status ? { status } : {}), ...(sourceGroup ? { sourceGroup } : {}), ...(leadType ? { leadType } : {}), ...(search ? { search } : {}), ...(cursor ? { cursor } : {}) });
  const state = useApi<{ items: LeadRow[]; nextCursor: string | null }>(`/api/v1/leads?${q}`);
  const team = useApi<{ items: Array<{ id: string; fullName: string }> }>('/api/v1/team');
  const name = (id: string | null) => team.data?.items.find((u) => u.id === id)?.fullName ?? (id ? '—' : 'Не назначен');

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Лиды</h1>
        <button className="btn" type="button" onClick={() => setCreating((v) => !v)}>
          + Создать лид
        </button>
      </div>
      {creating && <NewLeadForm onClose={() => setCreating(false)} />}
      <Section title="Фильтры">
        <div className="row">
          {(
            [
              ['Статус', status, setStatus, LEAD_STATUS_LABELS],
              ['Источник', sourceGroup, setSourceGroup, SOURCE_GROUP_LABELS],
              ['Тип лида', leadType, setLeadType, LEAD_TYPE_LABELS],
            ] as const
          ).map(([label, value, setter, labels]) => (
            <Field key={label} label={label}>
              <select value={value} onChange={(e) => (setCursor(undefined), setter(e.target.value))}>
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
            <input value={search} onChange={(e) => (setCursor(undefined), setSearch(e.target.value))} placeholder="Имя, телефон или @username" />
          </Field>
        </div>
      </Section>
      <Async state={state} isEmpty={(d) => d.items.length === 0}>
        {(d) => (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Лид</th>
                  <th>Статус</th>
                  <th>Источник</th>
                  <th>Тип</th>
                  <th>Ответственный</th>
                  <th>Создан</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <Link href={`/leads/${l.id}`}>{l.name}</Link>{' '}
                      {l.contactInstagramUsername && (
                        <span className="muted">
                          {l.name !== `@${l.contactInstagramUsername}` ? `@${l.contactInstagramUsername} · ` : ''}
                          <InstagramLink username={l.contactInstagramUsername} withHandle={false} />
                        </span>
                      )}{' '}
                      {l.slaBreachedAt && !l.firstHumanActionAt ? <Badge tone="bad">Срок ответа нарушен</Badge> : null}
                    </td>
                    <td>
                      <Badge tone={LEAD_STATUS_TONE[statusOfStage(l.stage)]}>{LEAD_STATUS_LABELS[statusOfStage(l.stage)]}</Badge>
                    </td>
                    <td>{SOURCE_GROUP_LABELS[sourceGroupOf(l.firstSource)]}</td>
                    <td>{LEAD_TYPE_LABELS[l.leadType] ?? '—'}</td>
                    <td>{name(l.ownerId)}</td>
                    <td>{fmtDateTime(l.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.nextCursor && (
              <button className="btn secondary" type="button" onClick={() => setCursor(d.nextCursor!)}>
                Следующая страница
              </button>
            )}
          </div>
        )}
      </Async>
    </>
  );
}
