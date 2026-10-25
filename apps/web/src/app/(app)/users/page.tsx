'use client';

import { useState } from 'react';
import { api, fmtDateTime, useApi, type ApiError } from '../../../lib/api';
import { Async, Badge, Field, FormError, Section } from '../../../components/ui';

interface U {
  id: string;
  email: string;
  fullName: string;
  role: string;
  status: string;
  amoUserId: string | null;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  extraCapabilities?: string[];
}

export default function UsersPage() {
  const state = useApi<{ items: U[] }>('/api/v1/users');
  const [error, setError] = useState<ApiError | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [f, setF] = useState({ email: '', fullName: '', role: 'MANAGER', amoUserId: '' });
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
      <h1>Foydalanuvchilar</h1>
      <FormError error={error} />
      <Section title="Xodimni taklif qilish (ochiq ro‘yxatdan o‘tish yo‘q)">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const r = await api<{ activationUrl: string }>('/api/v1/users', { method: 'POST', body: { ...f, amoUserId: f.amoUserId || null } });
              setInvite(r.activationUrl);
            });
          }}
        >
          <Field label="Email">
            <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          </Field>
          <Field label="F.I.Sh.">
            <input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} required />
          </Field>
          <Field label="Rol">
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="MANAGER">Menejer</option>
              <option value="HEAD">Rahbar</option>
              <option value="ADMIN">Administrator</option>
            </select>
          </Field>
          <Field label="amoCRM user_id">
            <input value={f.amoUserId} onChange={(e) => setF({ ...f, amoUserId: e.target.value })} />
          </Field>
          <button className="btn" type="submit">
            Taklif yaratish
          </button>
        </form>
        {invite && (
          <div className="state">
            Bir martalik aktivlashtirish havolasi (72 soat): <code style={{ wordBreak: 'break-all' }}>{invite}</code>
          </div>
        )}
      </Section>
      <Async state={state}>
        {(d) => (
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Xodim</th>
                  <th>Rol</th>
                  <th>Holat</th>
                  <th>amoCRM ID</th>
                  <th>MFA</th>
                  <th>Oxirgi kirish</th>
                  <th>Tannarx va foyda</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.items.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.fullName}
                      <div className="muted">{u.email}</div>
                    </td>
                    <td>{u.role}</td>
                    <td>
                      <Badge tone={u.status === 'active' ? 'ok' : u.status === 'blocked' ? 'bad' : 'info'}>{u.status}</Badge>
                    </td>
                    <td>{u.amoUserId ?? '—'}</td>
                    <td>{u.mfaEnabled ? 'Ha' : '—'}</td>
                    <td>{fmtDateTime(u.lastLoginAt)}</td>
                    <td>
                      {u.role === 'MANAGER' ? (
                        <label className="check">
                          <input
                            type="checkbox"
                            style={{ width: 'auto' }}
                            aria-label={`Tannarx va foydani ko‘rish: ${u.fullName}`}
                            checked={!!u.extraCapabilities?.includes('finance.cost.view')}
                            onChange={(e) => void act(() => api(`/api/v1/users/${u.id}/finance-access`, { method: 'PATCH', body: { enabled: e.target.checked } }))}
                          />{' '}
                          Ko‘ra oladi
                        </label>
                      ) : (
                        <span className="muted">{u.role === 'HEAD' || u.role === 'ADMIN' ? 'Standart ruxsat' : '—'}</span>
                      )}
                    </td>
                    <td>
                      {u.status === 'active' && (
                        <button
                          className="btn small danger"
                          type="button"
                          onClick={() => {
                            const successor = d.items.find((x) => x.status === 'active' && x.id !== u.id && x.role !== 'ADMIN');
                            if (window.confirm(`${u.fullName} bloklansinmi? Ochiq ishlar ${successor?.fullName ?? 'hech kimga'} o‘tkaziladi.`)) void act(() => api(`/api/v1/users/${u.id}/block`, { method: 'POST', body: { successorId: successor?.id ?? null } }));
                          }}
                        >
                          Bloklash
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
