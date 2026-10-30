'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  api,
  fmtDateTime,
  isoToTashkentLocal,
  LEAD_STATUS_LABELS,
  leadsListHref,
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
import { Async, Badge, Field, FormError, Initials, InstagramIconLink, LocalDateTimeField, Section, TargetBadge } from '../../../../components/ui';
import { Icon } from '../../../../components/icons';
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
  financeKept: { orders: number; payments: number };
  lead: { id: string; name: string; stage: string; leadType: string; version: number; ownerId: string | null; firstSource: string; contactId: string; createdAt: string; note: string | null; deletedAt: string | null; adReferralAt: string | null; adReferral: { adId?: string | null; adTitle?: string | null; source?: string | null } | null };
  events: Array<{ id: string; kind: string; oldStage: string | null; newStage: string | null; oldOwnerId: string | null; newOwnerId: string | null; reason: string | null; effectiveAt: string }>;
  contact: { id: string; fullName: string | null; firstName: string | null; lastName: string | null; primaryPhone: string | null; telegramUsername: string | null; instagramUsername: string | null; instagramName: string | null } | null;
  sale: Sale | null;
  conversations: Conversation[];
}

const EVENT_LABELS: Record<string, string> = { created: 'Лид создан', stage_change: 'Смена статуса', reopened: 'Статус изменён', owner_change: 'Смена ответственного', deleted: 'Лид удалён', restored: 'Лид восстановлен' };
const statusOf = (stage: string) => (stage === 'NEW' ? 'Новый' : stage === 'WON' ? 'Продано' : stage === 'LOST' ? 'Отменён' : stage === 'NO_ANSWER' ? 'Нет ответа' : 'В работе');

export default function LeadPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const router = useRouter();
  const state = useApi<LeadDetail>(`/api/v1/leads/${id}`, { pollMs: 15_000 });
  const team = useApi<{ items: Array<{ id: string; fullName: string; role: string }> }>('/api/v1/team');
  const [error, setError] = useState<ApiError | null>(null);
  const [editingContact, setEditingContact] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
        const deleted = !!l.deletedAt;
        // O'chirilgan lid faqat ko'rish uchun ochiladi (administrator tiklashi mumkin).
        const editable = !deleted && (me.role === 'ADMIN' || l.ownerId === me.id);
        const canDelete = works && editable;
        const displayName = c?.fullName && c.fullName !== 'Instagram mijoz' ? c.fullName : c?.instagramUsername ? `@${c.instagramUsername}` : l.name;
        return (
          <>
            <button className="btn ghost back" type="button" onClick={() => router.push(leadsListHref())}>
              <Icon name="arrowLeft" size={18} />К списку лидов
            </button>
            <header className="lead-head">
              <Initials name={displayName} size="lg" />
              <div className="lead-head-text">
                <h1>{displayName}</h1>
                <div className="lead-head-meta">
                  <span className="badge-group" aria-label="Статус">
                    <Badge tone={LEAD_STATUS_TONE[d.status]} className="status">
                      {LEAD_STATUS_LABELS[d.status]}
                    </Badge>
                  </span>
                  <span className="meta-item">
                    <span className="meta-label">Источник</span> {SOURCE_GROUP_LABELS[sourceGroupOf(l.firstSource)]}
                  </span>
                  <span className="meta-item">
                    <span className="meta-label">Тип</span> {LEAD_TYPE_LABELS[l.leadType] ?? l.leadType}
                  </span>
                  {(c?.instagramUsername || l.adReferralAt) && (
                    <span className="meta-item">
                      {c?.instagramUsername ? (
                        <>
                          @{c.instagramUsername} <InstagramIconLink username={c.instagramUsername} />
                        </>
                      ) : null}
                      <TargetBadge show={!!l.adReferralAt} />
                    </span>
                  )}
                </div>
              </div>
              {canDelete && (
                <button className="btn secondary small lead-delete" type="button" onClick={() => setConfirmDelete(true)}>
                  Удалить лид
                </button>
              )}
            </header>
            {deleted && (
              <div className="state error deleted-banner" role="status">
                <span>Лид удалён {fmtDateTime(l.deletedAt)}. Он скрыт из списков, поиска и панели управления; переписка и финансовые записи сохранены.</span>
                {canDo(me, 'leads.restore') && (
                  <button className="btn small" type="button" onClick={() => run(() => api(`/api/v1/leads/${id}/restore`, { method: 'POST' }))}>
                    Восстановить
                  </button>
                )}
              </div>
            )}
            {confirmDelete && (
              <DeleteLeadDialog
                name={displayName}
                finance={d.financeKept}
                onCancel={() => setConfirmDelete(false)}
                onConfirm={async () => {
                  await api(`/api/v1/leads/${id}`, { method: 'DELETE' });
                  router.push(leadsListHref());
                }}
              />
            )}
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
                            <span className="inline-ig">
                              @{c.instagramUsername} <InstagramIconLink username={c.instagramUsername} />
                            </span>
                            {c.instagramName ? <span className="muted"> · {c.instagramName}</span> : null}
                          </>
                        ) : (
                          '—'
                        )}
                      </dd>
                      {l.adReferralAt ? (
                        <>
                          <dt>Реклама</dt>
                          <dd>
                            {l.adReferral?.adTitle ?? 'Объявление Meta'}
                            {l.adReferral?.adId ? <span className="muted"> · ID {l.adReferral.adId}</span> : null}
                            <span className="muted"> · {fmtDateTime(l.adReferralAt)}</span>
                          </dd>
                        </>
                      ) : null}
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
                  key={l.id}
                  d={d}
                  canStatus={works && editable}
                  canBasics={editable}
                  canReassign={canDo(me, 'leads.reassign') && !deleted}
                  team={team.data?.items ?? []}
                  ownerName={userName(l.ownerId)}
                  onStatus={(status) => run(() => api(`/api/v1/leads/${id}/status`, { method: 'PATCH', body: { version: l.version, status } }))}
                  onBasics={(body) => run(() => api(`/api/v1/leads/${id}/basics`, { method: 'PATCH', body }))}
                  onSaveNote={async (note) => {
                    await api(`/api/v1/leads/${id}/basics`, { method: 'PATCH', body: { note } });
                    await state.reload();
                  }}
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
            <DirectChat leadId={l.id} clientName={displayName} conversations={d.conversations} canReply={works && editable} onSent={state.reload} />
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
  onSaveNote,
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
  onSaveNote: (note: string | null) => Promise<void>;
  onReassign: (userId: string) => void;
}) {
  const l = d.lead;
  const saved = l.note ?? '';
  const [note, setNote] = useState(saved);
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [noteError, setNoteError] = useState<ApiError | null>(null);
  const dirty = note.trim() !== saved.trim();
  // Заметку обновили с сервера (другой сотрудник, опрос) — подставляем, только если здесь ничего не правят.
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (lastSaved.current !== saved) {
      setNote((cur) => (cur.trim() === lastSaved.current.trim() ? saved : cur));
      lastSaved.current = saved;
    }
  }, [saved]);
  const saveNote = async () => {
    setNoteState('saving');
    setNoteError(null);
    try {
      await onSaveNote(note.trim() || null);
      setNoteState('saved');
    } catch (e) {
      setNoteError(e as ApiError);
      setNoteState('idle');
    }
  };
  return (
    <Section
      title="Лид"
      footer={
        canBasics ? (
          <>
            <span className="foot-status" role="status" aria-live="polite">
              {noteState === 'saving' ? 'Сохраняем…' : noteState === 'saved' && !dirty ? <span className="ok-text">Заметки сохранены</span> : dirty ? 'Есть несохранённые изменения' : 'Изменений нет'}
            </span>
            <button className="btn" type="button" disabled={!dirty || noteState === 'saving'} onClick={() => void saveNote()}>
              {noteState === 'saving' ? 'Сохранение…' : 'Сохранить заметки'}
            </button>
          </>
        ) : null
      }
    >
      <div className="form-grid">
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
        <textarea
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setNoteState('idle');
          }}
          rows={4}
          maxLength={4000}
          disabled={!canBasics}
          placeholder="Пожелания клиента, договорённости…"
        />
      </Field>
      <FormError error={noteError} />
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
          <div className="money-grid">
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
          </div>
          {!costHidden && (
            <div className="profit-box" aria-live="polite">
              <span className="profit-label">Прибыль</span>
              <strong className={profit?.startsWith('-') ? 'neg' : profit ? 'pos' : 'muted'}>{profit !== null ? fmtMoney(profit, f.currency) : 'Неизвестна'}</strong>
              <span className="hint">Цена продажи − себестоимость{profit === null ? ' · укажите обе суммы' : ''}</span>
            </div>
          )}
          {costHidden && <p className="hint">Себестоимость и прибыль видит администратор (или сотрудник с отдельным разрешением).</p>}
          <Field label="Дата и время вылета" hint="Время Ташкента (UTC+5)" error={error?.fieldErrors.departureAt}>
            <LocalDateTimeField value={f.departureAt} onValue={(v) => set('departureAt', v)} />
          </Field>
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
            <div className="card-foot">
              <span className="foot-status" role="status" aria-live="polite">
                {busy ? 'Сохраняем…' : saved ? <span className="ok-text">Продажа сохранена</span> : ''}
              </span>
              <button className="btn" type="submit" disabled={busy}>
                {busy ? 'Сохранение…' : 'Сохранить продажу'}
              </button>
            </div>
          )}
        </fieldset>
      </form>
    </Section>
  );
}

/** Состояние ответа — только то, что подтверждено: «принято Instagram» ≠ «доставлено» ≠ «прочитано». */
const OUT_STATE: Record<string, [string, 'pending' | 'ok' | 'bad']> = {
  queued: ['Отправляется…', 'pending'],
  sending: ['Отправляется…', 'pending'],
  accepted: ['Принято Instagram', 'ok'],
  delivered: ['Доставлено', 'ok'],
  read: ['Прочитано', 'ok'],
  failed: ['Не отправлено', 'bad'],
  unknown: ['Результат неизвестен — проверьте в Instagram, повторно не отправляется', 'bad'],
};

/** Вложения Instagram: ссылка на них не хранится, поэтому показываем понятную подпись без выдуманного превью. */
const ATTACHMENT_LABELS: Record<string, string> = {
  ig_post: 'Публикация Instagram',
  share: 'Публикация Instagram',
  ig_reel: 'Reels из Instagram',
  reel: 'Reels из Instagram',
  story_mention: 'Упоминание в истории',
  story_reply: 'Ответ на историю',
  image: 'Фото',
  video: 'Видео',
  audio: 'Голосовое сообщение',
  file: 'Файл',
  unsupported: 'Сообщение этого типа Instagram не передаёт',
};

const TZ = 'Asia/Tashkent';
const dayKey = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
const hhmm = (iso: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
function dayLabel(key: string) {
  const today = dayKey(new Date().toISOString());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString());
  if (key === today) return 'Сегодня';
  if (key === yesterday) return 'Вчера';
  const [y, m, d] = key.split('-');
  return `${d}.${m}.${y}`;
}

/** «Переписка Instagram»: только сообщения этого клиента; ответ уходит через официальный API Instagram. */
function DirectChat({ leadId, clientName, conversations, canReply, onSent }: { leadId: string; clientName: string; conversations: Conversation[]; canReply: boolean; onSent: () => Promise<void> }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const sendingRef = useRef(false);
  const keyRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prevCount = useRef(0);
  const conv = conversations[0] ?? null;
  const messages = conversations.flatMap((c) => c.messages).sort((a, b) => (a.providerAt ?? a.createdAt).localeCompare(b.providerAt ?? b.createdAt));
  const pending = messages.some((m) => m.direction === 'outbound' && (m.state === 'queued' || m.state === 'sending'));
  const toBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setUnseen(0);
  }, []);
  // Новые сообщения: прокручиваем вниз, только если читатель уже внизу; иначе показываем кнопку «Новые сообщения».
  useLayoutEffect(() => {
    const added = messages.length - prevCount.current;
    if (prevCount.current === 0 || atBottomRef.current) toBottom();
    else if (added > 0) setUnseen((n) => n + added);
    prevCount.current = messages.length;
  }, [messages.length, toBottom]);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void onSent(), 3000);
    return () => clearInterval(t);
  }, [pending, onSent]);
  const send = async () => {
    const body = text.trim();
    if (!body || sendingRef.current) return; // защита от двойной отправки (Enter + клик)
    sendingRef.current = true;
    setBusy(true);
    setError(null);
    keyRef.current ??= newKey(); // повтор после сбоя сети — тот же ключ, второй раз не отправится
    try {
      await api(`/api/v1/leads/${leadId}/messages`, { method: 'POST', body: { text: body }, idempotencyKey: keyRef.current });
      keyRef.current = null;
      setText('');
      atBottomRef.current = true;
      await onSent();
    } catch (e) {
      setError(e as ApiError); // текст остаётся в поле
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const peer = conv?.peerUsername ?? null;
  let lastDay = '';
  return (
    <section className="card chat-card" aria-label="Переписка Instagram">
      <header className="chat-head">
        <Initials name={peer ? `@${peer}` : clientName} />
        <div className="chat-head-text">
          <h2>Переписка Instagram</h2>
          <span className="muted">{peer ? `@${peer}` : clientName}</span>
        </div>
        {peer && (
          <a className="btn ghost small-ghost" href={`https://www.instagram.com/${encodeURIComponent(peer)}/`} target="_blank" rel="noopener noreferrer">
            <Icon name="instagram" size={16} />
            Профиль
          </a>
        )}
      </header>
      {!conv ? (
        <p className="chat-empty muted">Клиент не писал в Instagram Direct. Переписка появится автоматически, когда он напишет @nonatravel.uz.</p>
      ) : (
        <>
          <div className="chat-wrap">
            <div
              className="chat"
              ref={listRef}
              role="log"
              aria-live="polite"
              tabIndex={0}
              onScroll={(e) => {
                const el = e.currentTarget;
                atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
                if (atBottomRef.current) setUnseen(0);
              }}
            >
              {messages.length === 0 && <p className="chat-empty muted">Сообщений пока нет.</p>}
              {messages.map((m) => {
                const at = m.providerAt ?? m.createdAt;
                const day = dayKey(at);
                const sep = day !== lastDay;
                lastDay = day;
                const out = m.direction === 'outbound';
                const st = out ? OUT_STATE[m.state] : null;
                const label = ATTACHMENT_LABELS[m.type] ?? (m.type !== 'text' ? 'Вложение' : null);
                return (
                  <div key={m.id} className="chat-item">
                    {sep && (
                      <div className="day-sep">
                        <span>{dayLabel(day)}</span>
                      </div>
                    )}
                    <div className={`bubble ${out ? 'out' : 'in'}`}>
                      {out && m.isEcho && <span className="bubble-from">Отправлено из приложения Instagram</span>}
                      {m.contentPurgedAt ? (
                        <i className="bubble-note">Текст удалён по сроку хранения</i>
                      ) : m.content ? (
                        <p className="bubble-text">{m.content}</p>
                      ) : null}
                      {!m.contentPurgedAt && label && (
                        <span className="attach-card">
                          <Icon name={m.type === 'ig_post' || m.type === 'share' || m.type.includes('reel') ? 'instagram' : 'file'} size={16} />
                          <span>
                            {label}
                            {m.type !== 'unsupported' && <small>Откройте переписку в Instagram, чтобы посмотреть</small>}
                          </span>
                        </span>
                      )}
                      <span className="bubble-meta">
                        <time dateTime={at}>{hhmm(at)}</time>
                        {st && <span className={`msg-st ${st[1]}`}>{st[0]}</span>}
                      </span>
                      {out && m.state === 'failed' && m.error && <span className="bubble-error">{m.error}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            {unseen > 0 && (
              <button type="button" className="new-msgs" onClick={toBottom}>
                Новые сообщения: {unseen} ↓
              </button>
            )}
          </div>
          {canReply ? (
            conv.reply.allowed ? (
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <div className="composer-field">
                  <textarea
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      keyRef.current = null;
                    }}
                    onKeyDown={onKey}
                    rows={2}
                    maxLength={1000}
                    placeholder="Ответ клиенту в Instagram…"
                    aria-label="Текст ответа"
                    aria-describedby="composer-hint"
                  />
                  <span id="composer-hint" className="hint">
                    Enter — отправить · Shift+Enter — новая строка
                  </span>
                </div>
                <button className="btn" type="submit" disabled={busy || !text.trim()}>
                  {busy ? 'Отправка…' : 'Отправить'}
                </button>
              </form>
            ) : (
              <div className="state stale composer-note">Ответить сейчас нельзя: {conv.reply.message}</div>
            )
          ) : (
            <p className="composer-note muted">Отвечать клиенту могут администратор и ответственный менеджер.</p>
          )}
          {conv.reply.mode && conv.reply.mode !== 'live' && <p className="hint composer-note">Это демонстрационное подключение: сообщения не уходят в настоящий Instagram.</p>}
          <FormError error={error} />
        </>
      )}
    </section>
  );
}

/** Подтверждение удаления: лид уходит в корзину (soft delete), связанные записи не удаляются. */
function DeleteLeadDialog({ name, finance, onCancel, onConfirm }: { name: string; finance: { orders: number; payments: number }; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && !busy && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="delete-lead-title">
        <h2 id="delete-lead-title">Удалить лид «{name}»?</h2>
        <p>Лид исчезнет из списка лидов, поиска, счётчиков панели управления и ближайших вылетов. Администратор сможет восстановить его.</p>
        <p className="muted">Клиент, переписка в Instagram и история изменений сохраняются.</p>
        {finance.orders > 0 || finance.payments > 0 ? (
          <p className="modal-note">
            С лидом связаны финансовые записи (продаж: {finance.orders}, платежей: {finance.payments}). Они <b>не удаляются</b> и остаются в базе без изменений.
          </p>
        ) : null}
        <FormError error={error} />
        <div className="modal-actions">
          <button ref={cancelRef} className="btn secondary" type="button" disabled={busy} onClick={onCancel}>
            Отмена
          </button>
          <button
            className="btn danger"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
              } catch (e) {
                setError(e as ApiError);
                setBusy(false);
              }
            }}
          >
            {busy ? 'Удаление…' : 'Удалить лид'}
          </button>
        </div>
      </div>
    </div>
  );
}
