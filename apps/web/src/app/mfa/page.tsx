'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, type ApiError } from '../../lib/api';
import { Field, FormError } from '../../components/ui';

/** Administrator MFA enrollment (TZ §6.2). */
export default function MfaPage() {
  const router = useRouter();
  const [secret, setSecret] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <div className="card login">
      <h1>MFA sozlash</h1>
      <p>Administrator hisobi uchun ikki bosqichli tasdiqlash majburiy.</p>
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
          Sozlashni boshlash
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
          <p>Authenticator ilovasiga quyidagi kalitni kiriting:</p>
          <code style={{ wordBreak: 'break-all' }}>{secret.secret}</code>
          <Field label="6 xonali kod">
            <input inputMode="numeric" pattern="\d{6}" value={code} onChange={(e) => setCode(e.target.value)} required />
          </Field>
          <button className="btn" type="submit">
            Tasdiqlash
          </button>
        </form>
      )}
      <FormError error={error} />
    </div>
  );
}
