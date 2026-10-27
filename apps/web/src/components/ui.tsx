'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fmtDate, localToDmyHm, parseDmy, parseDmyHm, type ApiError, type Loadable } from '../lib/api';
import { Icon } from './icons';

export function Loading({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      {label}
    </div>
  );
}

export function Empty({ children = 'Нет данных' }: { children?: ReactNode }) {
  return <div className="state empty">{children}</div>;
}

export function ErrorBox({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  if (error.status === 403) return <div className="state denied" role="alert">Нет доступа: у вас нет прав на просмотр этого раздела.</div>;
  if (error.status === 404) return <div className="state denied" role="alert">Не найдено или недоступно для вас.</div>;
  return (
    <div className="state error" role="alert">
      <strong>Ошибка:</strong> {error.message}
      {onRetry && (
        <button type="button" className="btn small" onClick={onRetry}>
          Повторить
        </button>
      )}
    </div>
  );
}

/** Renders loading / error / permission / empty states consistently (TZ §20.2). */
export function Async<T>({ state, children, isEmpty }: { state: Loadable<T>; children: (data: T) => ReactNode; isEmpty?: (d: T) => boolean }) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error && !state.data) return <ErrorBox error={state.error} onRetry={() => void state.reload()} />;
  if (!state.data) return <Empty />;
  if (isEmpty?.(state.data)) return <Empty />;
  return (
    <>
      {state.error && <StaleNotice error={state.error} loadedAt={state.loadedAt} />}
      {children(state.data)}
    </>
  );
}

export function StaleNotice({ error, loadedAt }: { error: ApiError; loadedAt: Date | null }) {
  return (
    <div className="state stale" role="status">
      Данные могут быть устаревшими: последнее обновление {loadedAt ? loadedAt.toLocaleTimeString('ru-RU') : '—'} ({error.message})
    </div>
  );
}

export function Badge({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode; className?: string }) {
  return <span className={`badge ${tone}${className ? ` ${className}` : ''}`}>{children}</span>;
}

/** «Таргет»: клиент пришёл в Direct из рекламы — только по данным Meta (referral ADS / ad_id). Источник Instagram Direct не меняется. */
export function TargetBadge({ show }: { show: boolean | null | undefined }) {
  if (!show) return null;
  return (
    <span className="badge target" title="Клиент пришёл из рекламы (по данным Meta)">
      Таргет
    </span>
  );
}

/** Круглый значок с начальными буквами имени (без загрузки фото). */
export function Initials({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  const letters =
    name
      .replace(/^@/, '')
      .replace(/\(.*?\)/g, '')
      .trim()
      .split(/[\s._]+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?';
  return (
    <span className={`initials ${size}`} aria-hidden="true">
      {letters}
    </span>
  );
}

/** Отдельная иконка-ссылка на профиль Instagram (не путать с открытием карточки лида). */
export function InstagramIconLink({ username }: { username: string | null | undefined }) {
  if (!username || !/^[A-Za-z0-9._]{1,30}$/.test(username)) return null;
  return (
    <a className="ig-icon" href={`https://www.instagram.com/${encodeURIComponent(username)}/`} target="_blank" rel="noopener noreferrer" aria-label={`Профиль @${username} в Instagram`} title={`Открыть @${username} в Instagram`}>
      <Icon name="instagram" size={18} />
    </a>
  );
}

/** Ссылка на профиль клиента в Instagram (username — только буквы, цифры, точка и подчёркивание; иначе ссылка не показывается). */
export function InstagramLink({ username, withHandle = true }: { username: string | null | undefined; withHandle?: boolean }) {
  if (!username || !/^[A-Za-z0-9._]{1,30}$/.test(username)) return null;
  return (
    <a className="ig-link" href={`https://www.instagram.com/${encodeURIComponent(username)}/`} target="_blank" rel="noopener noreferrer" title="Открыть профиль в Instagram">
      {withHandle ? `@${username}` : 'Instagram'} ↗
    </a>
  );
}

/** Ввод даты: «ДД.ММ.ГГГГ» (не зависит от формата браузера). */
export function DateInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const mask = (raw: string) => {
    const d = raw.replace(/\D/g, '').slice(0, 8);
    return [d.slice(0, 2), d.slice(2, 4), d.slice(4, 8)].filter(Boolean).join('.') + (d.length === 2 || d.length === 4 ? '.' : '');
  };
  return <input value={value} onChange={(e) => onChange(mask(e.target.value))} inputMode="numeric" placeholder="ДД.ММ.ГГГГ" maxLength={10} aria-label={label} autoComplete="off" />;
}

const maskDigits = (raw: string, groups: number[], seps: string[]) => {
  const d = raw.replace(/\D/g, '').slice(0, groups.reduce((a, b) => a + b, 0));
  let out = '';
  let i = 0;
  groups.forEach((g, gi) => {
    const part = d.slice(i, i + g);
    i += g;
    if (part) out += (gi > 0 ? seps[gi - 1] : '') + part;
  });
  return out;
};

/** Карточки лида/заказа: дата вводится как «ДД.ММ.ГГГГ», значение хранится как «ГГГГ-ММ-ДД» (ISO). */
export function IsoDateField({ value, onValue, required, disabled }: { value: string; onValue: (v: string) => void; required?: boolean; disabled?: boolean }) {
  const [text, setText] = useState(value ? fmtDate(value) : '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if ((parseDmy(text) ?? '') !== value) setText(value ? fmtDate(value) : '');
  }, [value]);
  const invalid = text !== '' && parseDmy(text) === null;
  useEffect(() => ref.current?.setCustomValidity(invalid ? 'Введите дату в формате ДД.ММ.ГГГГ' : ''), [invalid]);
  return (
    <input
      ref={ref}
      value={text}
      inputMode="numeric"
      placeholder="ДД.ММ.ГГГГ"
      maxLength={10}
      required={required}
      disabled={disabled}
      aria-invalid={invalid}
      autoComplete="off"
      onChange={(e) => {
        const t = maskDigits(e.target.value, [2, 2, 4], ['.', '.']);
        setText(t);
        onValue(parseDmy(t) ?? '');
      }}
    />
  );
}

/** Дата и время: «ДД.ММ.ГГГГ ЧЧ:мм»; значение «ГГГГ-ММ-ДДTЧЧ:мм». */
export function LocalDateTimeField({ value, onValue, required, disabled }: { value: string; onValue: (v: string) => void; required?: boolean; disabled?: boolean }) {
  const [text, setText] = useState(localToDmyHm(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if ((parseDmyHm(text) ?? '') !== value) setText(localToDmyHm(value));
  }, [value]);
  const invalid = text !== '' && parseDmyHm(text) === null;
  useEffect(() => ref.current?.setCustomValidity(invalid ? 'Введите дату и время в формате ДД.ММ.ГГГГ ЧЧ:мм' : ''), [invalid]);
  return (
    <input
      ref={ref}
      value={text}
      inputMode="numeric"
      placeholder="ДД.ММ.ГГГГ ЧЧ:мм"
      maxLength={16}
      required={required}
      disabled={disabled}
      aria-invalid={invalid}
      autoComplete="off"
      onChange={(e) => {
        const raw = e.target.value.replace(/\D/g, '').slice(0, 12);
        const t = [raw.slice(0, 2), raw.slice(2, 4), raw.slice(4, 8)].filter(Boolean).join('.') + (raw.length > 8 ? ` ${[raw.slice(8, 10), raw.slice(10, 12)].filter(Boolean).join(':')}` : '');
        setText(t);
        onValue(parseDmyHm(t) ?? '');
      }}
    />
  );
}

/** Краткая справка: длинное пояснение спрятано за значком. */
export function Help({ children, label = 'Справка' }: { children: ReactNode; label?: string }) {
  return (
    <details className="help">
      <summary aria-label={label} title={label}>
        ⓘ
      </summary>
      <div className="help-body muted">{children}</div>
    </details>
  );
}

export function Field({ label, error, children, hint }: { label: string; error?: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

/** Подписи полей для сообщений проверки (ключ «_» — ошибка формы целиком). */
const FIELD_LABELS: Record<string, string> = {
  firstName: 'Имя',
  lastName: 'Фамилия',
  phone: 'Телефон',
  telegram: 'Telegram',
  instagram: 'Instagram',
  email: 'Логин',
  password: 'Пароль',
  note: 'Заметка',
  reason: 'Причина',
  from: 'Дата начала',
  to: 'Дата окончания',
  currency: 'Валюта',
  amount: 'Сумма',
  version: 'Версия',
};
const fieldLabel = (k: string) => (k === '_' ? '' : FIELD_LABELS[k] ? `${FIELD_LABELS[k]}: ` : '');

export function FormError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const fields = Object.entries(error.fieldErrors);
  return (
    <div className="state error" role="alert">
      {error.message}
      {fields.length > 0 && (
        <ul>
          {fields.map(([k, v]) => (
            <li key={k}>
              {fieldLabel(k)}
              {v}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Section({ title, actions, children, footer, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      <header className="card-head">
        <h2>{title}</h2>
        {actions}
      </header>
      {children}
      {footer && <footer className="card-foot">{footer}</footer>}
    </section>
  );
}
