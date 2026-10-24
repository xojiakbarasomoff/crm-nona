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
        <h1>Hisob faollashtirildi</h1>
        <Link href="/login">Tizimga kirish</Link>
      </div>
    );
  return (
    <form
      className="card login"
      onSubmit={async (e) => {
        e.preventDefault();
        if (password !== repeat) return setError({ message: 'Parollar mos emas', fieldErrors: {} } as ApiError);
        try {
          await api('/api/v1/auth/activate', { method: 'POST', body: { token, password } });
          setDone(true);
        } catch (err) {
          setError(err as ApiError);
        }
      }}
    >
      <h1>Parol o‘rnatish</h1>
      <Field label="Yangi parol" hint="Kamida 12 belgi">
        <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} />
      </Field>
      <Field label="Parolni takrorlang">
        <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
      </Field>
      <FormError error={error} />
      <button className="btn" type="submit">
        Saqlash
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
