'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SOURCE_LABELS, STAGE_LABELS, fmtDateTime, useApi } from '../../../lib/api';
import { Async, Badge, Field, InstagramLink, Section, SyncBadge } from '../../../components/ui';
import { NewLeadForm } from '../../../components/manual-lead';

interface LeadRow {
  id: string;
  name: string;
  stage: string;
  firstSource: string;
  syncState: string;
  createdAt: string;
  ownerId: string | null;
  anomaly: unknown;
  slaBreachedAt: string | null;
  firstHumanActionAt: string | null;
  contactInstagramUsername: string | null;
}

export default function LeadsPage() {
  const [stage, setStage] = useState('');
  const [search, setSearch] = useState('');
  // Boshqaruv paneli qidiruvi /leads?search=... orqali keladi (bir marta o'qiladi).
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('search');
    if (s) setSearch(s);
  }, []);
  const [cursor, setCursor] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const q = new URLSearchParams({ limit: '50', ...(stage ? { stage } : {}), ...(search ? { search } : {}), ...(cursor ? { cursor } : {}) });
  const state = useApi<{ items: LeadRow[]; nextCursor: string | null }>(`/api/v1/leads?${q}`);
  const team = useApi<{ items: Array<{ id: string; fullName: string }> }>('/api/v1/team');
  const name = (id: string | null) => team.data?.items.find((u) => u.id === id)?.fullName ?? (id ? '—' : 'Taqsimlanmagan');

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Lidlar</h1>
        <button className="btn" type="button" onClick={() => setCreating((v) => !v)}>
          + Yangi lid
        </button>
      </div>
      {creating && <NewLeadForm onClose={() => setCreating(false)} />}
      <p className="muted">Lid statusi va mas’ulning asosiy tizimi — amoCRM. Bu ro‘yxat lokal proyeksiya.</p>
      <Section title="Filtr">
        <div className="row">
          <Field label="Bosqich">
            <select value={stage} onChange={(e) => (setCursor(undefined), setStage(e.target.value))}>
              <option value="">Barchasi</option>
              {Object.entries(STAGE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Qidiruv">
            <input value={search} onChange={(e) => (setCursor(undefined), setSearch(e.target.value))} placeholder="Lid nomi" />
          </Field>
        </div>
      </Section>
      <Async state={state} isEmpty={(d) => d.items.length === 0}>
        {(d) => (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Lid</th>
                  <th>Bosqich</th>
                  <th>Birinchi manba</th>
                  <th>Mas’ul</th>
                  <th>Yaratilgan</th>
                  <th>Sinxron</th>
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
                      {l.anomaly ? <Badge tone="warn">Anomaliya</Badge> : null} {l.slaBreachedAt && !l.firstHumanActionAt ? <Badge tone="bad">SLA buzildi</Badge> : null}
                    </td>
                    <td>{STAGE_LABELS[l.stage]}</td>
                    <td>{SOURCE_LABELS[l.firstSource] ?? l.firstSource}</td>
                    <td>{name(l.ownerId)}</td>
                    <td>{fmtDateTime(l.createdAt)}</td>
                    <td>
                      <SyncBadge state={l.syncState} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.nextCursor && (
              <button className="btn secondary" type="button" onClick={() => setCursor(d.nextCursor!)}>
                Keyingi sahifa
              </button>
            )}
          </div>
        )}
      </Async>
    </>
  );
}
