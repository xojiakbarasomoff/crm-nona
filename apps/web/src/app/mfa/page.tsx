'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, type ApiError } from '../../lib/api';
import { Field, FormError } from '../../components/ui';

/** Настройка MFA для администратора (TZ §6.2). */
export default function MfaPage() {
  const router = useRouter();
  const [secret, setSecret] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <div className="card login">
      <h1>Настройка MFA</h1>
      <p>Для учётной записи администратора обязательна двухфакторная проверка.</p>
      {!secret ? (
        <button
          className="btn"
          type="button"
          onClick={async () => {
            try {
              setSecret(await api('/api/v1/auth/mfa/enroll', { method: 'POST' }));
            } catch (e) {
              const err = e as ApiError;
              if (err.code === 'MFA_ALREADY_ENABLED') router.replace('/login');
              setError(err);
            }
          }}
        >
          Начать настройку
        </button>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api('/api/v1/auth/mfa/confirm', { method: 'POST', body: { code } });
              router.replace('/dashboard');
            } catch (err) {
              setError(err as ApiError);
            }
          }}
        >
          <p>Введите этот ключ в приложение-аутентификатор:</p>
          <code style={{ wordBreak: 'break-all' }}>{secret.secret}</code>
          <Field label="Код из 6 цифр">
            <input inputMode="numeric" pattern="\d{6}" value={code} onChange={(e) => setCode(e.target.value)} required />
          </Field>
          <button className="btn" type="submit">
            Подтвердить
          </button>
        </form>
      )}
      <FormError error={error} />
    </div>
  );
}
