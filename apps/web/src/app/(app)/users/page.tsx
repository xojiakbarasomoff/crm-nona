'use client';

import { useState } from 'react';
import { api, fmtDateTime, ROLE_LABELS, useApi, type ApiError } from '../../../lib/api';
import { USER_STATUS_LABELS } from '../../../lib/format';
import { Async, Badge, Field, FormError, Section } from '../../../components/ui';

interface U {
  id: string;
  email: string;
  login: string | null;
  fullName: string;
  role: string;
  status: string;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  extraCapabilities?: string[];
}

export default function UsersPage() {
  const state = useApi<{ items: U[] }>('/api/v1/users');
  const [error, setError] = useState<ApiError | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [f, setF] = useState({ email: '', fullName: '', role: 'MANAGER' });
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await state.reload();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  return (
    <>
      <h1>Пользователи</h1>
      <FormError error={error} />
      <Section title="Пригласить сотрудника (самостоятельной регистрации нет)">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const r = await api<{ activationUrl: string }>('/api/v1/users', { method: 'POST', body: f });
              setInvite(r.activationUrl);
            });
          }}
        >
          <Field label="Email">
            <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          </Field>
          <Field label="Имя и фамилия">
            <input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} required />
          </Field>
          <Field label="Роль">
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="MANAGER">Менеджер</option>
              <option value="USER">Пользователь</option>
              <option value="ADMIN">Администратор</option>
            </select>
          </Field>
          <button className="btn" type="submit">
            Создать приглашение
          </button>
        </form>
        {invite && (
          <div className="state">
            Одноразовая ссылка активации (72 часа): <code style={{ wordBreak: 'break-all' }}>{invite}</code>
          </div>
        )}
      </Section>
      <Async state={state}>
        {(d) => (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th>Роль</th>
                  <th>Статус</th>
                  <th>MFA</th>
                  <th>Последний вход</th>
                  <th>Себестоимость и прибыль</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.items.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.fullName}
                      <div className="muted">{u.login ?? u.email}</div>
                    </td>
                    <td>{ROLE_LABELS[u.role] ?? u.role}</td>
                    <td>
                      <Badge tone={u.status === 'active' ? 'ok' : u.status === 'blocked' ? 'bad' : 'info'}>{USER_STATUS_LABELS[u.status] ?? u.status}</Badge>
                    </td>
                    <td>{u.mfaEnabled ? 'Да' : '—'}</td>
                    <td>{fmtDateTime(u.lastLoginAt)}</td>
                    <td>
                      {u.role === 'MANAGER' ? (
                        <label className="check">
                          <input
                            type="checkbox"
                            style={{ width: 'auto' }}
                            aria-label={`Видеть себестоимость и прибыль: ${u.fullName}`}
                            checked={!!u.extraCapabilities?.includes('finance.cost.view')}
                            onChange={(e) => void act(() => api(`/api/v1/users/${u.id}/finance-access`, { method: 'PATCH', body: { enabled: e.target.checked } }))}
                          />{' '}
                          Может видеть
                        </label>
                      ) : (
                        <span className="muted">{u.role === 'ADMIN' ? 'Есть по роли' : '—'}</span>
                      )}
                    </td>
                    <td>
                      {u.status === 'active' && (
                        <button
                          className="btn small danger"
                          type="button"
                          onClick={() => {
                            const successor = d.items.find((x) => x.status === 'active' && x.id !== u.id && x.role === 'ADMIN');
                            if (window.confirm(`Заблокировать ${u.fullName}? Открытые дела будут переданы: ${successor?.fullName ?? 'никому'}.`)) void act(() => api(`/api/v1/users/${u.id}/block`, { method: 'POST', body: { successorId: successor?.id ?? null } }));
                          }}
                        >
                          Заблокировать
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </>
  );
}
