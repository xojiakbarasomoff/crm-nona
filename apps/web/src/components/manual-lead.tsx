'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, type ApiError } from '../lib/api';
import { Field, FormError, Section } from './ui';
import { canDo, useMe } from './shell';

interface Candidate {
  id: string;
  name: string | null;
  instagramUsername: string | null;
  telegramUsername: string | null;
  leads: number;
}

const candidateLabel = (c: Candidate) => c.name ?? (c.instagramUsername ? `@${c.instagramUsername}` : c.telegramUsername ? `@${c.telegramUsername}` : 'Ismsiz kontakt');

/** Telefon boshqa kontaktda bo'lsa: avtomatik birlashtirilmaydi — foydalanuvchi tanlaydi. */
function Candidates({ error, onPick, onForce, forceLabel }: { error: ApiError; onPick?: (id: string) => void; onForce: () => void; forceLabel: string }) {
  const list = (error.details.candidates as Candidate[] | undefined) ?? [];
  const hidden = Number(error.details.hiddenCount ?? 0);
  return (
    <div className="state stale" role="alert">
      <b>Bu telefon raqami boshqa kontaktda mavjud.</b> Avtomatik birlashtirilmaydi.
      <ul>
        {list.map((c) => (
          <li key={c.id}>
            <a href={`/contacts/${c.id}`} target="_blank" rel="noopener noreferrer">
              {candidateLabel(c)}
            </a>{' '}
            <span className="muted">· lidlar: {c.leads}</span>{' '}
            {onPick && (
              <button type="button" className="btn secondary" onClick={() => onPick(c.id)}>
                Shu kontaktga lid yaratish
              </button>
            )}
          </li>
        ))}
        {hidden > 0 && <li className="muted">Boshqa xodimlarga tegishli {hidden} ta kontakt ham bor (ko‘rish huquqingiz yo‘q).</li>}
      </ul>
      <button type="button" className="btn secondary" onClick={onForce}>
        {forceLabel}
      </button>
    </div>
  );
}

/** Lidlar sahifasi: «+ Yangi lid». Manba — «Qo'lda kiritilgan»; mas'ul mavjud tayinlash qoidalari bilan. */
export function NewLeadForm({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const router = useRouter();
  const [team, setTeam] = useState<Array<{ id: string; fullName: string; role: string }> | null>(null);
  const [f, setF] = useState({ firstName: '', lastName: '', phone: '', telegram: '', name: '', ownerId: '', note: '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const canPick = canDo(me, 'leads.reassign');
  useEffect(() => {
    if (!canPick) return;
    void api<{ items: Array<{ id: string; fullName: string; role: string }> }>('/api/v1/team').then((r) => setTeam(r.items)).catch(() => undefined);
  }, [canPick]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (extra: { existingContactId?: string; forceNewContact?: boolean } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { ...extra };
      for (const [k, v] of Object.entries(f)) if (v.trim()) body[k] = v.trim();
      const lead = await api<{ id: string }>('/api/v1/leads', { method: 'POST', body });
      router.push(`/leads/${lead.id}`);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Yangi lid">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="row">
          <Field label="Ism" error={error?.fieldErrors.firstName}>
            <input value={f.firstName} onChange={set('firstName')} maxLength={100} autoFocus />
          </Field>
          <Field label="Familiya" error={error?.fieldErrors.lastName}>
            <input value={f.lastName} onChange={set('lastName')} maxLength={100} />
          </Field>
        </div>
        <p className="muted">Ism yoki familiyadan kamida bittasi kerak.</p>
        <div className="row">
          <Field label="Telefon raqami" error={error?.fieldErrors.phone} hint="+998901234567 ko‘rinishida">
            <input value={f.phone} onChange={set('phone')} inputMode="tel" maxLength={40} />
          </Field>
          <Field label="Telegram username" error={error?.fieldErrors.telegram} hint="@ bilan yoki usiz">
            <input value={f.telegram} onChange={set('telegram')} maxLength={120} />
          </Field>
        </div>
        <div className="row">
          <Field label="Lid nomi (ixtiyoriy)">
            <input value={f.name} onChange={set('name')} maxLength={200} placeholder="Bo‘sh bo‘lsa — mijoz ismi" />
          </Field>
          {canPick && (
            <Field label="Mas’ul menejer" error={error?.fieldErrors.ownerId}>
              <select value={f.ownerId} onChange={set('ownerId')}>
                <option value="">Avtomatik (mavjud qoidalar)</option>
                {(team ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <Field label="Izoh">
          <textarea value={f.note} onChange={set('note')} maxLength={2000} rows={3} />
        </Field>
        {error && error.code !== 'PHONE_EXISTS' && <FormError error={error} />}
        {error?.code === 'PHONE_EXISTS' && <Candidates error={error} onPick={(id) => void submit({ existingContactId: id })} onForce={() => void submit({ forceNewContact: true })} forceLabel="Baribir yangi kontakt yaratish" />}
        <div className="row">
          <button className="btn" type="submit" disabled={busy}>
            Lidni yaratish
          </button>
          <button className="btn secondary" type="button" onClick={onClose}>
            Bekor qilish
          </button>
        </div>
      </form>
    </Section>
  );
}

/** Lid kartasi: mijozning ism, familiya, telefon va Telegram username'ini tahrirlash (Instagram identifikatorlari o'zgarmaydi). */
export function ContactEditForm({
  leadId,
  contact,
  onSaved,
  onCancel,
}: {
  leadId: string;
  contact: { fullName: string | null; firstName: string | null; lastName: string | null; primaryPhone: string | null; telegramUsername: string | null };
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState({ firstName: contact.firstName ?? '', lastName: contact.lastName ?? '', phone: contact.primaryPhone ?? '', telegram: contact.telegramUsername ? `@${contact.telegramUsername}` : '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async (allowDuplicatePhone = false) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/leads/${leadId}/contact`, { method: 'PATCH', body: { firstName: f.firstName.trim() || null, lastName: f.lastName.trim() || null, phone: f.phone.trim() || null, telegram: f.telegram.trim() || null, ...(allowDuplicatePhone ? { allowDuplicatePhone: true } : {}) } });
      onSaved();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label="Ism" error={error?.fieldErrors.firstName}>
        <input value={f.firstName} onChange={set('firstName')} maxLength={100} />
      </Field>
      <Field label="Familiya" error={error?.fieldErrors.lastName}>
        <input value={f.lastName} onChange={set('lastName')} maxLength={100} />
      </Field>
      <Field label="Telefon" error={error?.fieldErrors.phone}>
        <input value={f.phone} onChange={set('phone')} inputMode="tel" maxLength={40} />
      </Field>
      <Field label="Telegram username" error={error?.fieldErrors.telegram}>
        <input value={f.telegram} onChange={set('telegram')} maxLength={120} />
      </Field>
      {error && error.code !== 'PHONE_EXISTS' && <FormError error={error} />}
      {error?.code === 'PHONE_EXISTS' && <Candidates error={error} onForce={() => void save(true)} forceLabel="Baribir saqlash (birlashtirilmaydi, dublikat tekshiruviga qo‘yiladi)" />}
      <div className="row">
        <button className="btn" type="submit" disabled={busy}>
          Saqlash
        </button>
        <button className="btn secondary" type="button" onClick={onCancel}>
          Bekor qilish
        </button>
      </div>
    </form>
  );
}
