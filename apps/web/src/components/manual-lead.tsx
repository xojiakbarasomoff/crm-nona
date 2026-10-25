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

const candidateLabel = (c: Candidate) => c.name ?? (c.instagramUsername ? `@${c.instagramUsername}` : c.telegramUsername ? `@${c.telegramUsername}` : 'Контакт без имени');

/** Если телефон уже есть у другого контакта, автоматического объединения нет — выбор за пользователем. */
function Candidates({ error, onPick, onForce, forceLabel }: { error: ApiError; onPick?: (id: string) => void; onForce: () => void; forceLabel: string }) {
  const list = (error.details.candidates as Candidate[] | undefined) ?? [];
  const hidden = Number(error.details.hiddenCount ?? 0);
  return (
    <div className="state stale" role="alert">
      <b>Этот номер телефона уже есть у другого контакта.</b> Автоматически контакты не объединяются.
      <ul>
        {list.map((c) => (
          <li key={c.id}>
            <a href={`/contacts/${c.id}`} target="_blank" rel="noopener noreferrer">
              {candidateLabel(c)}
            </a>{' '}
            <span className="muted">· лидов: {c.leads}</span>{' '}
            {onPick && (
              <button type="button" className="btn secondary" onClick={() => onPick(c.id)}>
                Создать лид для этого контакта
              </button>
            )}
          </li>
        ))}
        {hidden > 0 && <li className="muted">Есть ещё контакты других сотрудников: {hidden} (у вас нет прав на просмотр).</li>}
      </ul>
      <button type="button" className="btn secondary" onClick={onForce}>
        {forceLabel}
      </button>
    </div>
  );
}

/** Страница лидов: «+ Создать лид». Источник — «Добавлен вручную»; ответственный назначается по действующим правилам. */
export function NewLeadForm({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const router = useRouter();
  const [team, setTeam] = useState<Array<{ id: string; fullName: string; role: string }> | null>(null);
  const [f, setF] = useState({ firstName: '', lastName: '', phone: '', telegram: '', instagram: '', leadType: 'NEW', name: '', ownerId: '', note: '' });
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
    <Section title="Новый лид">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="row">
          <Field label="Имя" error={error?.fieldErrors.firstName}>
            <input value={f.firstName} onChange={set('firstName')} maxLength={100} autoFocus />
          </Field>
          <Field label="Фамилия" error={error?.fieldErrors.lastName}>
            <input value={f.lastName} onChange={set('lastName')} maxLength={100} />
          </Field>
        </div>
        <p className="muted">Нужно указать хотя бы имя или фамилию.</p>
        <div className="row">
          <Field label="Номер телефона" error={error?.fieldErrors.phone} hint="В формате +998901234567">
            <input value={f.phone} onChange={set('phone')} inputMode="tel" maxLength={40} />
          </Field>
          <Field label="Telegram username" error={error?.fieldErrors.telegram} hint="С @ или без">
            <input value={f.telegram} onChange={set('telegram')} maxLength={120} />
          </Field>
          <Field label="Instagram username" error={error?.fieldErrors.instagram} hint="@username или ссылка на профиль">
            <input value={f.instagram} onChange={set('instagram')} maxLength={200} />
          </Field>
          <Field label="Тип лида">
            <select value={f.leadType} onChange={set('leadType')}>
              <option value="NEW">Новый</option>
              <option value="REFERRAL">По рекомендации</option>
              <option value="REPEAT">Повторный</option>
            </select>
          </Field>
        </div>
        <div className="row">
          <Field label="Название лида (необязательно)">
            <input value={f.name} onChange={set('name')} maxLength={200} placeholder="Если пусто — имя клиента" />
          </Field>
          {canPick && (
            <Field label="Ответственный" error={error?.fieldErrors.ownerId}>
              <select value={f.ownerId} onChange={set('ownerId')}>
                <option value="">Автоматически (по правилам)</option>
                {(team ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {!canPick && <p className="muted">Ответственный — вы ({me.fullName}). Источник — «Вручную».</p>}
        <Field label="Заметка">
          <textarea value={f.note} onChange={set('note')} maxLength={2000} rows={3} />
        </Field>
        {error && error.code !== 'PHONE_EXISTS' && <FormError error={error} />}
        {error?.code === 'PHONE_EXISTS' && <Candidates error={error} onPick={(id) => void submit({ existingContactId: id })} onForce={() => void submit({ forceNewContact: true })} forceLabel="Всё равно создать новый контакт" />}
        <div className="row">
          <button className="btn" type="submit" disabled={busy}>
            Создать лид
          </button>
          <button className="btn secondary" type="button" onClick={onClose}>
            Отмена
          </button>
        </div>
      </form>
    </Section>
  );
}

/** Карточка лида: редактирование имени, фамилии, телефона и Telegram клиента (идентификаторы Instagram не меняются). */
export function ContactEditForm({
  leadId,
  contact,
  onSaved,
  onCancel,
  instagramEditable = false,
}: {
  leadId: string;
  contact: { fullName: string | null; firstName: string | null; lastName: string | null; primaryPhone: string | null; telegramUsername: string | null; instagramUsername?: string | null };
  onSaved: () => void;
  onCancel: () => void;
  /** Клиент без переписки в Direct: Instagram username можно ввести вручную. */
  instagramEditable?: boolean;
}) {
  const [f, setF] = useState({ firstName: contact.firstName ?? '', lastName: contact.lastName ?? '', phone: contact.primaryPhone ?? '', telegram: contact.telegramUsername ? `@${contact.telegramUsername}` : '', instagram: contact.instagramUsername ? `@${contact.instagramUsername}` : '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async (allowDuplicatePhone = false) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/leads/${leadId}/contact`, { method: 'PATCH', body: { firstName: f.firstName.trim() || null, lastName: f.lastName.trim() || null, phone: f.phone.trim() || null, telegram: f.telegram.trim() || null, ...(instagramEditable ? { instagram: f.instagram.trim() || null } : {}), ...(allowDuplicatePhone ? { allowDuplicatePhone: true } : {}) } });
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
      <Field label="Имя" error={error?.fieldErrors.firstName}>
        <input value={f.firstName} onChange={set('firstName')} maxLength={100} />
      </Field>
      <Field label="Фамилия" error={error?.fieldErrors.lastName}>
        <input value={f.lastName} onChange={set('lastName')} maxLength={100} />
      </Field>
      <Field label="Телефон" error={error?.fieldErrors.phone}>
        <input value={f.phone} onChange={set('phone')} inputMode="tel" maxLength={40} />
      </Field>
      <Field label="Telegram username" error={error?.fieldErrors.telegram}>
        <input value={f.telegram} onChange={set('telegram')} maxLength={120} />
      </Field>
      {instagramEditable && (
        <Field label="Instagram username" error={error?.fieldErrors.instagram} hint="@username или ссылка на профиль">
          <input value={f.instagram} onChange={set('instagram')} maxLength={200} />
        </Field>
      )}
      {error && error.code !== 'PHONE_EXISTS' && <FormError error={error} />}
      {error?.code === 'PHONE_EXISTS' && <Candidates error={error} onForce={() => void save(true)} forceLabel="Всё равно сохранить (контакты не объединяются)" />}
      <div className="row">
        <button className="btn" type="submit" disabled={busy}>
          Сохранить
        </button>
        <button className="btn secondary" type="button" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}
