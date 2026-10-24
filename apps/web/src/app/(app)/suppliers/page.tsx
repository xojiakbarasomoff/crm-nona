'use client';

import { useState } from 'react';
import { api, useApi, type ApiError } from '../../../lib/api';
import { SUPPLIER_KIND_LABELS } from '../../../lib/format';
import { Async, Badge, Field, FormError, Section } from '../../../components/ui';
import { canDo, useMe } from '../../../components/shell';

interface Supplier {
  id: string;
  name: string;
  kind: string;
  status: 'active' | 'archived';
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  note?: string | null;
  version?: number;
}

const EMPTY = { name: '', kind: 'tour_operator', contactPerson: '', phone: '', email: '', note: '' };

/**
 * Turoperatorlar va xizmat yetkazib beruvchilar ma'lumotnomasi.
 * Bu reklama manbasi emas: «Instagram Ads» — mijoz qayerdan kelgan; turoperator — xizmatni kim yetkazib beradi.
 */
export default function SuppliersPage() {
  const me = useMe();
  const manage = canDo(me, 'suppliers.manage');
  const [status, setStatus] = useState<'active' | 'archived' | 'all'>('active');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const query = new URLSearchParams({ status, ...(kind ? { kind } : {}), ...(q ? { q } : {}) });
  const state = useApi<{ items: Supplier[] }>(`/api/v1/suppliers?${query}`);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<ApiError | null>(null);
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const nul = (v: string) => (v.trim() === '' ? null : v.trim());

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await state.reload();
      return true;
    } catch (e) {
      setError(e as ApiError);
      return false;
    }
  };

  const startEdit = (s: Supplier) => {
    setEditing(s);
    setForm({ name: s.name, kind: s.kind, contactPerson: s.contactPerson ?? '', phone: s.phone ?? '', email: s.email ?? '', note: s.note ?? '' });
  };

  return (
    <>
      <h1>Turoperatorlar va yetkazib beruvchilar</h1>
      <p className="muted">
        Bu ma’lumotnoma xizmatni <b>yetkazib beruvchini</b> bildiradi. Reklama manbasi (masalan, «Instagram Ads») bilan aralashtirmang: manba — mijoz qayerdan kelgani. Ma’lumotnomadagi keyingi o‘zgarishlar eski buyurtmalarning narxlariga ta’sir qilmaydi.
      </p>

      <Section title="Filtr">
        <div className="row">
          <Field label="Holat">
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="active">Faol</option>
              <option value="archived">Arxiv</option>
              <option value="all">Barchasi</option>
            </select>
          </Field>
          <Field label="Turi">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Barchasi</option>
              {Object.entries(SUPPLIER_KIND_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nom bo‘yicha qidiruv">
            <input value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
        </div>
      </Section>

      <FormError error={error} />
      <Async state={state} isEmpty={(d) => d.items.length === 0}>
        {(d) => (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nomi</th>
                  <th>Turi</th>
                  {manage && <th>Mas’ul shaxs</th>}
                  {manage && <th>Aloqa</th>}
                  {manage && <th>Izoh</th>}
                  <th>Holat</th>
                  {manage && <th />}
                </tr>
              </thead>
              <tbody>
                {d.items.map((s) => (
                  <tr key={s.id} className={s.status === 'archived' ? 'row-cancelled' : ''}>
                    <td>
                      <b>{s.name}</b>
                    </td>
                    <td>{SUPPLIER_KIND_LABELS[s.kind] ?? s.kind}</td>
                    {manage && <td>{s.contactPerson ?? '—'}</td>}
                    {manage && (
                      <td>
                        {s.phone ?? '—'}
                        <div className="muted">{s.email ?? ''}</div>
                      </td>
                    )}
                    {manage && <td className="muted">{s.note ?? ''}</td>}
                    <td>{s.status === 'active' ? <Badge tone="ok">Faol</Badge> : <Badge>Arxiv</Badge>}</td>
                    {manage && (
                      <td>
                        <button type="button" className="btn small secondary" onClick={() => startEdit(s)}>
                          Tahrirlash
                        </button>
                        <button
                          type="button"
                          className="btn small secondary"
                          onClick={() => run(() => api(`/api/v1/suppliers/${s.id}`, { method: 'PATCH', body: { version: s.version, status: s.status === 'active' ? 'archived' : 'active' } }))}
                        >
                          {s.status === 'active' ? 'Arxivlash' : 'Faollashtirish'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>

      {manage ? (
        <Section title={editing ? `Tahrirlash: ${editing.name}` : 'Yangi turoperator / yetkazib beruvchi'}>
          <form
            className="row"
            onSubmit={async (e) => {
              e.preventDefault();
              const body = { name: form.name, kind: form.kind, contactPerson: nul(form.contactPerson), phone: nul(form.phone), email: nul(form.email), note: nul(form.note) };
              const ok = await run(() => (editing ? api(`/api/v1/suppliers/${editing.id}`, { method: 'PATCH', body: { version: editing.version, ...body } }) : api('/api/v1/suppliers', { method: 'POST', body })));
              if (ok) {
                setEditing(null);
                setForm(EMPTY);
              }
            }}
          >
            <Field label="Kompaniya nomi">
              <input value={form.name} onChange={set('name')} required />
            </Field>
            <Field label="Turi">
              <select value={form.kind} onChange={set('kind')}>
                {Object.entries(SUPPLIER_KIND_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Mas’ul shaxs">
              <input value={form.contactPerson} onChange={set('contactPerson')} />
            </Field>
            <Field label="Telefon">
              <input value={form.phone} onChange={set('phone')} inputMode="tel" />
            </Field>
            <Field label="Email">
              <input type="email" value={form.email} onChange={set('email')} />
            </Field>
            <Field label="Izoh">
              <input value={form.note} onChange={set('note')} />
            </Field>
            <button className="btn" type="submit">
              {editing ? 'O‘zgarishni saqlash' : 'Yaratish'}
            </button>
            {editing && (
              <button
                className="btn secondary"
                type="button"
                onClick={() => {
                  setEditing(null);
                  setForm(EMPTY);
                }}
              >
                Bekor qilish
              </button>
            )}
          </form>
        </Section>
      ) : (
        <p className="muted">Ma’lumotnomani o‘zgartirish rahbar va administrator uchun. Siz lidga turoperator tanlay olasiz; aloqa ma’lumotlari ko‘rsatilmaydi.</p>
      )}
    </>
  );
}
