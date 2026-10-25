'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  api,
  fmtDateTime,
  isoToTashkentLocal,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
  LEAD_TYPE_LABELS,
  newKey,
  SALE_SERVICE_LABELS,
  SOURCE_GROUP_LABELS,
  SOURCE_LABELS,
  sourceGroupOf,
  STAGE_LABELS,
  tashkentLocalToIso,
  useApi,
  type ApiError,
} from '../../../../lib/api';
import { CURRENCIES, fmtMoney, profitPreview } from '../../../../lib/format';
import { Async, Badge, Field, FormError, InstagramLink, LocalDateTimeField, Section } from '../../../../components/ui';
import { canDo, canWrite, useMe } from '../../../../components/shell';
import { Attachments } from '../../../../components/attachments';
import { ContactEditForm } from '../../../../components/manual-lead';
import { LeadFormAnswers, type FormInquiry } from '../../../../components/lead-form-answers';

interface Sale {
  orderId: string;
  orderNo: string;
  serviceType: 'avia' | 'tour_package' | 'other' | null;
  soldWhat: string | null;
  tourOperator: { id: string; name: string } | null;
  currency: string | null;
  amount: string | null;
  netAmount: string | null;
  profit: string | null;
  costHidden: boolean;
  departureAt: string | null;
  departureNote: string | null;
  remindEnabled: boolean;
  remindAt: string | null;
  reminder: { state: 'off' | 'scheduled' | 'due' | 'done' | 'departed'; dueAt: string | null; timezone: string };
}

interface ChatMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  type: string;
  content: string | null;
  state: string;
  error: string | null;
  isEcho: boolean;
  providerAt: string | null;
  createdAt: string;
  contentPurgedAt: string | null;
}

interface Conversation {
  id: string;
  peerUsername: string | null;
  lastInboundAt: string | null;
  messages: ChatMessage[];
  reply: { allowed: boolean; reason: string | null; message: string | null; mode: string | null };
}

interface LeadDetail {
  inquiries: FormInquiry[];
  status: string;
  lead: { id: string; name: string; stage: string; leadType: string; version: number; ownerId: string | null; firstSource: string; contactId: string; createdAt: string; note: string | null };
  events: Array<{ id: string; kind: string; oldStage: string | null; newStage: string | null; oldOwnerId: string | null; newOwnerId: string | null; reason: string | null; effectiveAt: string }>;
  contact: { id: string; fullName: string | null; firstName: string | null; lastName: string | null; primaryPhone: string | null; telegramUsername: string | null; instagramUsername: string | null; instagramName: string | null } | null;
  sale: Sale | null;
  conversations: Conversation[];
}

const EVENT_LABELS: Record<string, string> = { created: 'Лид создан', stage_change: 'Смена статуса', reopened: 'Статус изменён', owner_change: 'Смена ответственного' };
const statusOf = (stage: string) => (stage === 'NEW' ? 'Новый' : stage === 'WON' ? 'Продано' : stage === 'LOST' ? 'Отменён' : stage === 'NO_ANSWER' ? 'Нет ответа' : 'В работе');

export default function LeadPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const state = useApi<LeadDetail>(`/api/v1/leads/${id}`, { pollMs: 15_000 });
  const team = useApi<{ items: Array<{ id: string; fullName: string; role: string }> }>('/api/v1/team');
  const [error, setError] = useState<ApiError | null>(null);
  const [editingContact, setEditingContact] = useState(false);
  const works = canWrite(me); // статус, продажа, ответ клиенту — Администратор и Менеджер
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await state.reload();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  const userName = (uid: string | null) => (uid === me.id ? me.fullName : (team.data?.items.find((u) => u.id === uid)?.fullName ?? (uid ? 'Сотрудник' : 'Не назначен')));

  return (
    <Async state={state}>
      {(d) => {
        const l = d.lead;
        const c = d.contact;
        const editable = me.role === 'ADMIN' || l.ownerId === me.id;
        const displayName = c?.fullName && c.fullName !== 'Instagram mijoz' ? c.fullName : c?.instagramUsername ? `@${c.instagramUsername}` : l.name;
        return (
          <>
            <p className="muted">
              <Link href="/leads">← Лиды</Link>
            </p>
            <div className="lead-head">
              <h1>{displayName}</h1>
              <Badge tone={LEAD_STATUS_TONE[d.status]}>{LEAD_STATUS_LABELS[d.status]}</Badge>
              <Badge>{SOURCE_GROUP_LABELS[sourceGroupOf(l.firstSource)]}</Badge>
              <Badge tone="info">{LEAD_TYPE_LABELS[l.leadType] ?? l.leadType}</Badge>
            </div>
            <FormError error={error} />
            <div className="split even">
              <div>
                <Section
                  title="Клиент"
                  actions={
                    editable && c && !editingContact ? (
                      <button className="btn secondary small" type="button" onClick={() => setEditingContact(true)}>
                        Редактировать
                      </button>
                    ) : null
                  }
                >
                  {c && editingContact ? (
                    <ContactEditForm
                      leadId={l.id}
                      contact={c}
                      instagramEditable={d.conversations.length === 0}
                      onCancel={() => setEditingContact(false)}
                      onSaved={() => {
                        setEditingContact(false);
                        void state.reload();
                      }}
                    />
                  ) : c ? (
                    <dl className="kv2">
                      <dt>Имя</dt>
                      <dd>{c.firstName ?? '—'}</dd>
                      <dt>Фамилия</dt>
                      <dd>{c.lastName ?? '—'}</dd>
                      <dt>Телефон</dt>
                      <dd>{c.primaryPhone ? <a href={`tel:${c.primaryPhone}`}>{c.primaryPhone}</a> : '—'}</dd>
                      <dt>Instagram</dt>
                      <dd>
                        {c.instagramUsername ? (
                          <>
                            @{c.instagramUsername} <InstagramLink username={c.instagramUsername} withHandle={false} />
                            {c.instagramName ? <span className="muted"> · {c.instagramName}</span> : null}
                          </>
                        ) : (
                          '—'
                        )}
                      </dd>
                      <dt>Telegram</dt>
                      <dd>
                        {c.telegramUsername ? (
                          <a href={`https://t.me/${encodeURIComponent(c.telegramUsername)}`} target="_blank" rel="noopener noreferrer">
                            @{c.telegramUsername}
                          </a>
                        ) : (
                          '—'
                        )}
                      </dd>
                    </dl>
                  ) : (
                    '—'
                  )}
                </Section>
                <LeadForm
                  key={`${l.id}:${l.version}`}
                  d={d}
                  canStatus={works && editable}
                  canBasics={editable}
                  canReassign={canDo(me, 'leads.reassign')}
                  team={team.data?.items ?? []}
                  ownerName={userName(l.ownerId)}
                  onStatus={(status) => run(() => api(`/api/v1/leads/${id}/status`, { method: 'PATCH', body: { version: l.version, status } }))}
                  onBasics={(body) => run(() => api(`/api/v1/leads/${id}/basics`, { method: 'PATCH', body }))}
                  onReassign={(userId) => run(() => api(`/api/v1/leads/${id}/assignee`, { method: 'PATCH', body: { userId, reason: 'Решение администратора' } }))}
                />
              </div>
              <div>
                {d.status === 'SOLD' ? (
                  <SaleBlock key={d.sale ? `${d.sale.orderId}:${JSON.stringify(d.sale)}` : 'new'} leadId={l.id} sale={d.sale} readOnly={!(works && editable)} onSaved={() => void state.reload()} />
                ) : (
                  <Section title="Продажа">
                    <p className="muted">Блок «Продажа» открывается, когда статус лида — «Продано».</p>
                  </Section>
                )}
                <LeadFormAnswers inquiries={d.inquiries ?? []} />
              </div>
            </div>
            <DirectChat leadId={l.id} conversations={d.conversations} canReply={works && editable} onSent={() => void state.reload()} />
            <details className="lead-more">
              <summary>История и файлы</summary>
              <Section title="История">
                <ul>
                  {d.events.map((e) => (
                    <li key={e.id}>
                      {fmtDateTime(e.effectiveAt)} — {EVENT_LABELS[e.kind] ?? e.kind}
                      {e.newStage ? `: ${e.oldStage ? statusOf(e.oldStage) : '∅'} → ${statusOf(e.newStage)}` : ''}
                      {e.newStage && e.oldStage && statusOf(e.oldStage) === statusOf(e.newStage) ? <span className="muted"> ({STAGE_LABELS[e.oldStage]} → {STAGE_LABELS[e.newStage]})</span> : null}
                      {e.newOwnerId ? ` · ответственный: ${userName(e.oldOwnerId)} → ${userName(e.newOwnerId)}` : ''}
                      {e.reason ? <span className="muted"> ({e.reason})</span> : null}
                    </li>
                  ))}
                </ul>
              </Section>
              <Attachments ownerType="lead" ownerId={id} />
            </details>
          </>
        );
      }}
    </Async>
  );
}

function LeadForm({
  d,
  canStatus,
  canBasics,
  canReassign,
  team,
  ownerName,
  onStatus,
  onBasics,
  onReassign,
}: {
  d: LeadDetail;
  canStatus: boolean;
  canBasics: boolean;
  canReassign: boolean;
  team: Array<{ id: string; fullName: string; role: string }>;
  ownerName: string;
  onStatus: (s: string) => void;
  onBasics: (b: { leadType?: string; note?: string | null }) => void;
  onReassign: (userId: string) => void;
}) {
  const l = d.lead;
  const [note, setNote] = useState(l.note ?? '');
  return (
    <Section title="Лид">
      <div className="row">
        <Field label="Источник">
          <input value={`${SOURCE_GROUP_LABELS[sourceGroupOf(l.firstSource)]}${sourceGroupOf(l.firstSource) === 'ADS' ? ` (${SOURCE_LABELS[l.firstSource] ?? l.firstSource})` : ''}`} readOnly aria-readonly="true" />
        </Field>
        <Field label="Тип лида">
          <select value={l.leadType} disabled={!canBasics} onChange={(e) => onBasics({ leadType: e.target.value })}>
            {Object.entries(LEAD_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Статус" hint={d.status === 'NO_ANSWER' ? 'Клиент не отвечает' : undefined}>
          <select value={d.status} disabled={!canStatus} onChange={(e) => onStatus(e.target.value)} aria-label="Статус">
            {Object.entries(LEAD_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row">
        <Field label="Ответственный">
          {canReassign ? (
            <select value={l.ownerId ?? ''} onChange={(e) => e.target.value && e.target.value !== l.ownerId && onReassign(e.target.value)}>
              {!l.ownerId && <option value="">Не назначен</option>}
              {team.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName}
                </option>
              ))}
            </select>
          ) : (
            <input value={ownerName} readOnly aria-readonly="true" />
          )}
        </Field>
        <Field label="Создан">
          <input value={fmtDateTime(l.createdAt)} readOnly aria-readonly="true" />
        </Field>
      </div>
      <Field label="Заметки">
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={4000} disabled={!canBasics} placeholder="Пожелания клиента, договорённости…" />
      </Field>
      {canBasics && (
        <button className="btn" type="button" disabled={note === (l.note ?? '')} onClick={() => onBasics({ note: note.trim() || null })}>
          Сохранить заметки
        </button>
      )}
    </Section>
  );
}

const REMINDER_LABELS: Record<Sale['reminder']['state'], string> = { off: 'Выключено', scheduled: 'Запланировано', due: 'Пора напомнить', done: 'Выполнено', departed: 'Вылет прошёл' };

/** Блок «Продажа»: тип услуги, туроператор, цены (одна валюта), вылет и напоминание. */
function SaleBlock({ leadId, sale, readOnly, onSaved }: { leadId: string; sale: Sale | null; readOnly: boolean; onSaved: () => void }) {
  const ops = useApi<{ items: Array<{ id: string; name: string; status: string }> }>('/api/v1/suppliers?status=active&kind=tour_operator');
  const costHidden = sale?.costHidden ?? false;
  const [f, setF] = useState({
    serviceType: sale?.serviceType ?? 'avia',
    soldWhat: sale?.soldWhat ?? '',
    tourOperatorId: sale?.tourOperator?.id ?? '',
    amount: sale?.amount ?? '',
    netAmount: sale?.netAmount ?? '',
    currency: sale?.currency ?? 'USD',
    departureAt: isoToTashkentLocal(sale?.departureAt),
    departureNote: sale?.departureNote ?? '',
    remindEnabled: sale?.remindEnabled ?? false,
    customRemind: !!sale?.remindAt,
    remindAt: isoToTashkentLocal(sale?.remindAt),
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => {
    setSaved(false);
    setF((s) => ({ ...s, [k]: v }));
  };
  const options = ops.data?.items ?? [];
  const allOps = sale?.tourOperator && !options.some((o) => o.id === sale.tourOperator!.id) ? [...options, { ...sale.tourOperator, status: 'archived' }] : options;
  const profit = !costHidden && f.amount && f.netAmount ? profitPreview(f.amount, f.netAmount) : null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/leads/${leadId}/sale`, {
        method: 'PUT',
        body: {
          serviceType: f.serviceType,
          soldWhat: f.serviceType === 'other' ? f.soldWhat.trim() || null : null,
          tourOperatorId: f.tourOperatorId || null,
          amount: f.amount.trim() || null,
          ...(costHidden ? {} : { netAmount: f.netAmount.trim() || null }),
          currency: f.currency,
          departureAt: f.departureAt ? tashkentLocalToIso(f.departureAt) : null,
          departureNote: f.departureNote.trim() || null,
          remindEnabled: f.remindEnabled,
          remindAt: f.remindEnabled && f.customRemind && f.remindAt ? tashkentLocalToIso(f.remindAt) : null,
          timezone: 'Asia/Tashkent',
        },
      });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Продажа" actions={sale ? <span className="muted">Заказ {sale.orderNo}</span> : null}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={readOnly || busy} className="plain">
          <div className="seg" role="radiogroup" aria-label="Тип услуги">
            {(['avia', 'tour_package', 'other'] as const).map((t) => (
              <label key={t} className={f.serviceType === t ? 'on' : ''}>
                <input type="radio" name="serviceType" value={t} checked={f.serviceType === t} onChange={() => set('serviceType', t)} />
                {SALE_SERVICE_LABELS[t]}
              </label>
            ))}
          </div>
          {f.serviceType === 'other' && (
            <Field label="Что продано?" error={error?.fieldErrors.soldWhat}>
              <input value={f.soldWhat} onChange={(e) => set('soldWhat', e.target.value)} maxLength={500} required />
            </Field>
          )}
          <Field label="Туроператор">
            <select value={f.tourOperatorId} onChange={(e) => set('tourOperatorId', e.target.value)}>
              <option value="">Не выбран</option>
              {allOps.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.status === 'archived' ? ' (архив)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <div className="row">
            <Field label="Цена продажи" error={error?.fieldErrors.amount}>
              <input value={f.amount} onChange={(e) => set('amount', e.target.value)} inputMode="decimal" pattern="\d+(\.\d{1,2})?" placeholder="Не указана" />
            </Field>
            {!costHidden && (
              <Field label="Себестоимость" error={error?.fieldErrors.netAmount}>
                <input value={f.netAmount} onChange={(e) => set('netAmount', e.target.value)} inputMode="decimal" pattern="\d+(\.\d{1,2})?" placeholder="Не указана" />
              </Field>
            )}
            <Field label="Валюта" error={error?.fieldErrors.currency}>
              <select value={f.currency} onChange={(e) => set('currency', e.target.value)}>
                {CURRENCIES.map((cur) => (
                  <option key={cur}>{cur}</option>
                ))}
              </select>
            </Field>
            {!costHidden && (
              <Field label="Прибыль (цена − себестоимость)">
                <input value={profit !== null ? fmtMoney(profit, f.currency) : 'Неизвестна'} readOnly aria-readonly="true" className={profit?.startsWith('-') ? 'neg' : ''} />
              </Field>
            )}
          </div>
          {costHidden && <p className="hint">Себестоимость и прибыль видит администратор (или сотрудник с отдельным разрешением).</p>}
          <div className="row">
            <Field label="Дата и время вылета" hint="Время Ташкента (UTC+5)" error={error?.fieldErrors.departureAt}>
              <LocalDateTimeField value={f.departureAt} onValue={(v) => set('departureAt', v)} />
            </Field>
          </div>
          <Field label="Примечание" hint="Номер рейса, маршрут, что продано — вручную">
            <textarea value={f.departureNote} onChange={(e) => set('departureNote', e.target.value)} rows={2} maxLength={1000} placeholder="Например: HY-601 Ташкент → Стамбул" />
          </Field>
          <label className="check">
            <input type="checkbox" checked={f.remindEnabled} onChange={(e) => set('remindEnabled', e.target.checked)} />
            Напомнить о вылете
          </label>
          {f.remindEnabled && (
            <div className="remind-box">
              <label className="check">
                <input type="checkbox" checked={!f.customRemind} onChange={(e) => set('customRemind', !e.target.checked)} />
                За 3 дня до вылета
              </label>
              {f.customRemind && (
                <Field label="Своё время напоминания" hint="Время Ташкента (UTC+5)" error={error?.fieldErrors.remindAt}>
                  <LocalDateTimeField value={f.remindAt} onValue={(v) => set('remindAt', v)} required />
                </Field>
              )}
              <p className="hint">Напоминание придёт ответственному сотруднику в CRM (уведомления) со ссылкой на этот лид. Часовой пояс: Asia/Tashkent.</p>
            </div>
          )}
          {sale && (
            <p className="muted">
              Напоминание: <Badge tone={sale.reminder.state === 'due' ? 'bad' : sale.reminder.state === 'scheduled' ? 'info' : 'neutral'}>{REMINDER_LABELS[sale.reminder.state]}</Badge>
              {sale.reminder.dueAt ? ` · ${fmtDateTime(sale.reminder.dueAt, sale.reminder.timezone)} (${sale.reminder.timezone})` : ''}
            </p>
          )}
          <FormError error={error} />
          {!readOnly && (
            <div className="row">
              <button className="btn" type="submit" disabled={busy}>
                Сохранить продажу
              </button>
              {saved && <span className="ok-text">Сохранено</span>}
            </div>
          )}
        </fieldset>
      </form>
    </Section>
  );
}

const OUT_STATE: Record<string, [string, 'neutral' | 'ok' | 'warn' | 'bad' | 'info']> = {
  queued: ['Отправляется…', 'warn'],
  sending: ['Отправляется…', 'warn'],
  accepted: ['Отправлено (принято Instagram)', 'ok'],
  delivered: ['Доставлено', 'ok'],
  read: ['Прочитано', 'ok'],
  failed: ['Не отправлено', 'bad'],
  unknown: ['Результат неизвестен — проверьте в Instagram, повторно не отправляется', 'bad'],
};

/** «Переписка Instagram»: только сообщения этого клиента; ответ уходит через официальный API Instagram. */
function DirectChat({ leadId, conversations, canReply, onSent }: { leadId: string; conversations: Conversation[]; canReply: boolean; onSent: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const conv = conversations[0] ?? null;
  const messages = conversations.flatMap((c) => c.messages).sort((a, b) => (a.providerAt ?? a.createdAt).localeCompare(b.providerAt ?? b.createdAt));
  const pending = messages.some((m) => m.direction === 'outbound' && (m.state === 'queued' || m.state === 'sending'));
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(onSent, 3000);
    return () => clearInterval(t);
  }, [pending, onSent]);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    keyRef.current ??= newKey(); // повтор после сбоя сети — тот же ключ, второй раз не отправится
    try {
      await api(`/api/v1/leads/${leadId}/messages`, { method: 'POST', body: { text: text.trim() }, idempotencyKey: keyRef.current });
      keyRef.current = null;
      setText('');
      onSent();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Переписка Instagram" actions={conv?.peerUsername ? <InstagramLink username={conv.peerUsername} /> : null}>
      {!conv ? (
        <p className="muted">Клиент не писал в Instagram Direct. Переписка появится автоматически, когда он напишет @nonatravel.uz.</p>
      ) : (
        <>
          <div className="chat" ref={listRef} aria-live="polite">
            {messages.length === 0 && <p className="muted">Сообщений пока нет.</p>}
            {messages.map((m) => {
              const out = m.direction === 'outbound';
              const st = out ? OUT_STATE[m.state] : null;
              return (
                <div key={m.id} className={`msg ${out ? 'out' : 'in'}`}>
                  <div className="msg-meta">
                    {out ? (m.isEcho ? 'NONA (из Instagram)' : 'NONA') : 'Клиент'} · {fmtDateTime(m.providerAt ?? m.createdAt)}
                  </div>
                  <div>{m.contentPurgedAt ? <i className="muted">Текст удалён по сроку хранения</i> : m.content ?? <i className="muted">[{m.type}]</i>}</div>
                  {st && !m.isEcho && (
                    <div className="msg-state">
                      <Badge tone={st[1]}>{st[0]}</Badge>
                      {m.state === 'failed' && m.error ? <span className="err-text"> {m.error}</span> : null}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {canReply &&
            (conv.reply.allowed ? (
              <form
                className="reply"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <textarea
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    keyRef.current = null;
                  }}
                  rows={2}
                  maxLength={1000}
                  placeholder="Ответ клиенту в Instagram…"
                  aria-label="Текст ответа"
                />
                <button className="btn" type="submit" disabled={busy || !text.trim()}>
                  Отправить
                </button>
              </form>
            ) : (
              <div className="state stale">Ответить сейчас нельзя: {conv.reply.message}</div>
            ))}
          {conv.reply.mode && conv.reply.mode !== 'live' && <p className="hint">Это демонстрационное подключение: сообщения не уходят в настоящий Instagram.</p>}
          <FormError error={error} />
        </>
      )}
    </Section>
  );
}
