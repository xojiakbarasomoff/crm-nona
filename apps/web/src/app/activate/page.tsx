'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, type ApiError } from '../../lib/api';
import { Field, FormError } from '../../components/ui';

function ActivateForm() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  if (done)
    return (
      <div className="card login">
        <h1>Учётная запись активирована</h1>
        <Link href="/login">Войти в систему</Link>
      </div>
    );
  return (
    <form
      className="card login"
      onSubmit={async (e) => {
        e.preventDefault();
        if (password !== repeat) return setError({ message: 'Пароли не совпадают', fieldErrors: {} } as ApiError);
        try {
          await api('/api/v1/auth/activate', { method: 'POST', body: { token, password } });
          setDone(true);
        } catch (err) {
          setError(err as ApiError);
        }
      }}
    >
      <h1>Установка пароля</h1>
      <Field label="Новый пароль" hint="Не менее 12 символов">
        <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} />
      </Field>
      <Field label="Повторите пароль">
        <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
      </Field>
      <FormError error={error} />
      <button className="btn" type="submit">
        Сохранить
      </button>
    </form>
  );
}

export default function ActivatePage() {
  return (
    <Suspense>
      <ActivateForm />
    </Suspense>
  );
}
