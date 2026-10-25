'use client';

import { useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, type ApiError } from '../../lib/api';
import { Field, FormError } from '../../components/ui';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="card login"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api('/api/v1/auth/login', { method: 'POST', body: { email, password, ...(totp ? { totp } : {}) } });
          router.replace(params.get('next') ?? '/dashboard');
        } catch (err) {
          const e2 = err as ApiError;
          if (e2.code === 'MFA_REQUIRED') setNeedTotp(true);
          setError(e2);
        } finally {
          setBusy(false);
        }
      }}
    >
      <img className="login-logo" src="/nona-logo-bordo.png" alt="NONA Travel" width={200} height={110} />
      <h1>Вход в систему</h1>
      <Field label="Логин">
        <input type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </Field>
      <Field label="Пароль">
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </Field>
      {needTotp && (
        <Field label="Код MFA (6 цифр)">
          <input inputMode="numeric" pattern="\d{6}" autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} required />
        </Field>
      )}
      <FormError error={error} />
      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Входим…' : 'Войти'}
      </button>
      <p className="muted">Самостоятельной регистрации нет. Учётную запись создаёт администратор.</p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
