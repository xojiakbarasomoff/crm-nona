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
 * Справочник туроператоров и поставщиков услуг.
 * Это не рекламный источник: «Instagram Ads» — откуда пришёл клиент; туроператор — кто поставляет услугу.
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
      <h1>Туроператоры и поставщики</h1>
      <p className="muted">
        Список <b>поставщиков услуг</b>. Это не рекламный источник. Изменения не влияют на цены прошлых заказов.
      </p>

      <Section title="Фильтры">
        <div className="row">
          <Field label="Статус">
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="active">Активные</option>
              <option value="archived">Архив</option>
              <option value="all">Все</option>
            </select>
          </Field>
          <Field label="Тип">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Все</option>
              {Object.entries(SUPPLIER_KIND_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Поиск по названию">
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
                  <th>Название</th>
                  <th>Тип</th>
                  {manage && <th>Контактное лицо</th>}
                  {manage && <th>Контакты</th>}
                  {manage && <th>Заметка</th>}
                  <th>Статус</th>
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
                    <td>{s.status === 'active' ? <Badge tone="ok">Активен</Badge> : <Badge>Архив</Badge>}</td>
                    {manage && (
                      <td>
                        <button type="button" className="btn small secondary" onClick={() => startEdit(s)}>
                          Редактировать
                        </button>
                        <button
                          type="button"
                          className="btn small secondary"
                          onClick={() => run(() => api(`/api/v1/suppliers/${s.id}`, { method: 'PATCH', body: { version: s.version, status: s.status === 'active' ? 'archived' : 'active' } }))}
                        >
                          {s.status === 'active' ? 'В архив' : 'Вернуть из архива'}
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
        <Section title={editing ? `Редактирование: ${editing.name}` : 'Новый туроператор / поставщик'}>
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
            <Field label="Название компании">
              <input value={form.name} onChange={set('name')} required />
            </Field>
            <Field label="Тип">
              <select value={form.kind} onChange={set('kind')}>
                {Object.entries(SUPPLIER_KIND_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Контактное лицо">
              <input value={form.contactPerson} onChange={set('contactPerson')} />
            </Field>
            <Field label="Телефон">
              <input value={form.phone} onChange={set('phone')} inputMode="tel" />
            </Field>
            <Field label="Email">
              <input type="email" value={form.email} onChange={set('email')} />
            </Field>
            <Field label="Заметка">
              <input value={form.note} onChange={set('note')} />
            </Field>
            <button className="btn" type="submit">
              {editing ? 'Сохранить изменения' : 'Создать'}
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
                Отмена
              </button>
            )}
          </form>
        </Section>
      ) : (
        <p className="muted">Редактировать справочник может администратор. Вы можете выбрать туроператора в карточке лида.</p>
      )}
    </>
  );
}
