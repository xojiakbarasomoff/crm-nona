'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, fmtDateTime, newKey, SOURCE_LABELS, STAGE_LABELS, useApi, type ApiError } from '../../../../lib/api';
import { Async, Badge, Field, FormError, Section, SyncBadge } from '../../../../components/ui';
import { canDo, useMe } from '../../../../components/shell';
import { Attachments } from '../../../../components/attachments';

interface LeadDetail {
  lead: {
    id: string;
    name: string;
    stage: string;
    version: number;
    ownerId: string | null;
    firstSource: string;
    firstPlacement: string;
    syncState: string;
    amoLeadId: string | null;
    contactId: string;
    requirements: Record<string, unknown>;
    serviceType: string | null;
    contactOutcome: string | null;
    offerPrepDueAt: string | null;
    lostReasonCode: string | null;
    nextContactAt: string | null;
    followUpNote: string | null;
    anomaly: { stage: string; missing: string[] } | null;
    pendingChange: { stage?: string; ownerId?: string } | null;
    firstResponseDueAt: string | null;
    firstHumanActionAt: string | null;
    slaBreachedAt: string | null;
    createdAt: string;
  };
  events: Array<{ id: string; kind: string; oldStage: string | null; newStage: string | null; oldOwnerId: string | null; newOwnerId: string | null; origin: string; reason: string | null; effectiveAt: string }>;
  offers: Array<{ id: string; version: number; content: string; amount: string; currency: string; sentAt: string | null; acceptedAt: string | null; validUntil: string | null }>;
  orders: Array<{ id: string; orderNo: string; fulfillmentState: string }>;
  contact: { id: string; fullName: string | null; primaryPhone: string | null } | null;
  pendingOperations: Array<{ id: string; action: string; state: string; lastError: string | null }>;
}

export default function LeadPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const router = useRouter();
  const state = useApi<LeadDetail>(`/api/v1/leads/${id}`);
  const team = useApi<{ items: Array<{ id: string; fullName: string; role: string }> }>('/api/v1/team');
  const [error, setError] = useState<ApiError | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await state.reload();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  const userName = (uid: string | null) => team.data?.items.find((u) => u.id === uid)?.fullName ?? '—';

  return (
    <Async state={state}>
      {(d) => {
        const l = d.lead;
        const req = l.requirements as Record<string, string | number | null>;
        return (
          <>
            <h1>
              {l.name} <SyncBadge state={l.syncState} />
            </h1>
            <p className="muted">
              Bosqich: <b>{STAGE_LABELS[l.stage]}</b>
              {l.pendingChange && (
                <>
                  {' '}
                  → <Badge tone="info">Sinxronlanmoqda: {l.pendingChange.stage ? STAGE_LABELS[l.pendingChange.stage] : `mas’ul ${userName(l.pendingChange.ownerId ?? null)}`}</Badge>
                </>
              )}{' '}
              · Mas’ul: {userName(l.ownerId)} · Manba: {SOURCE_LABELS[l.firstSource]} ({l.firstPlacement}) · amoCRM ID: {l.amoLeadId ?? 'hali yaratilmagan'} · SLA: {fmtDateTime(l.firstResponseDueAt)}
            </p>
            {l.slaBreachedAt && !l.firstHumanActionAt && <div className="state error">SLA buzildi: birinchi inson javobi {fmtDateTime(l.firstResponseDueAt)} gacha qayd etilmadi.</div>}
            {l.anomaly && (
              <div className="state stale">
                Anomaliya: amoCRM’da «{STAGE_LABELS[l.anomaly.stage]}» bosqichi uchun ma’lumot yetishmaydi — {l.anomaly.missing.join(', ')}. Tuzatish vazifasi yaratilgan.
              </div>
            )}
            {d.pendingOperations.length > 0 && (
              <div className="state">
                amoCRM operatsiyalari: {d.pendingOperations.map((o) => `${o.action} (${o.state}${o.lastError ? `: ${o.lastError}` : ''})`).join('; ')}
              </div>
            )}
            <FormError error={error} />
            <div className="split">
              <div>
                <RequirementsForm lead={l} req={req} onSave={(body) => run(() => api(`/api/v1/leads/${id}`, { method: 'PATCH', body: { version: l.version, ...body } }))} />
                <OffersSection
                  offers={d.offers}
                  onCreate={(body) => run(() => api(`/api/v1/leads/${id}/offers`, { method: 'POST', body, idempotencyKey: newKey() }))}
                  onSent={(oid) => run(() => api(`/api/v1/offers/${oid}/sent`, { method: 'POST', body: { channel: 'instagram_direct' } }))}
                  onAccept={(oid) => run(() => api(`/api/v1/offers/${oid}/accept`, { method: 'POST' }))}
                />
                <Attachments ownerType="lead" ownerId={id} />
                <Section title="Tarix">
                  <ul>
                    {d.events.map((e) => (
                      <li key={e.id}>
                        {fmtDateTime(e.effectiveAt)} — {e.kind}
                        {e.newStage ? `: ${e.oldStage ? STAGE_LABELS[e.oldStage] : '∅'} → ${STAGE_LABELS[e.newStage]}` : ''}
                        {e.newOwnerId ? ` · mas’ul: ${userName(e.oldOwnerId)} → ${userName(e.newOwnerId)}` : ''} <span className="muted">({e.origin}{e.reason ? `, ${e.reason}` : ''})</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              </div>
              <div>
                <Section title="Bosqichni o‘zgartirish">
                  <StageChanger current={l.stage} disabled={!!l.pendingChange} onChange={(stage) => run(() => api(`/api/v1/leads/${id}/stage`, { method: 'PATCH', body: { version: l.version, stage } }))} />
                  {canDo(me, 'leads.reopen') && (l.stage === 'WON' || l.stage === 'LOST') && (
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() => {
                        const reason = window.prompt('Qayta ochish sababi');
                        if (reason) void run(() => api(`/api/v1/leads/${id}/reopen`, { method: 'POST', body: { reason } }));
                      }}
                    >
                      Qayta ochish
                    </button>
                  )}
                </Section>
                {canDo(me, 'leads.reassign') && (
                  <Section title="Mas’ulni o‘zgartirish">
                    <select
                      aria-label="Yangi mas’ul"
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) void run(() => api(`/api/v1/leads/${id}/assignee`, { method: 'PATCH', body: { userId: e.target.value, reason: 'Rahbar qarori' } }));
                      }}
                    >
                      <option value="">Tanlang…</option>
                      {team.data?.items.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.fullName}
                        </option>
                      ))}
                    </select>
                  </Section>
                )}
                <Section title="Mijoz">
                  {d.contact ? (
                    <>
                      <div>{d.contact.fullName ?? '—'}</div>
                      <div className="muted">{d.contact.primaryPhone ?? 'Telefon yo‘q'}</div>
                      <Link href={`/contacts/${d.contact.id}`}>Mijoz kartasi va yozishmalar</Link>
                    </>
                  ) : (
                    '—'
                  )}
                </Section>
                <Section title="Buyurtma">
                  {d.orders.length ? (
                    d.orders.map((o) => (
                      <div key={o.id}>
                        <Link href={`/orders/${o.id}`}>{o.orderNo}</Link> <Badge>{o.fulfillmentState}</Badge>
                      </div>
                    ))
                  ) : (
                    <button className="btn" type="button" onClick={() => run(async () => router.push(`/orders/${(await api<{ id: string }>('/api/v1/orders', { method: 'POST', body: { leadId: id } })).id}`))}>
                      Buyurtma yaratish
                    </button>
                  )}
                </Section>
              </div>
            </div>
          </>
        );
      }}
    </Async>
  );
}

function StageChanger({ current, disabled, onChange }: { current: string; disabled: boolean; onChange: (s: string) => void }) {
  const [stage, setStage] = useState('');
  return (
    <div className="row">
      <select aria-label="Yangi bosqich" value={stage} onChange={(e) => setStage(e.target.value)} disabled={disabled}>
        <option value="">Tanlang…</option>
        {Object.entries(STAGE_LABELS)
          .filter(([k]) => k !== current)
          .map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
      </select>
      <button className="btn" type="button" disabled={!stage || disabled} onClick={() => onChange(stage)}>
        amoCRM’ga yuborish
      </button>
      {disabled && <span className="hint">Oldingi o‘zgarish sinxronlanmoqda</span>}
    </div>
  );
}

function RequirementsForm({ lead, req, onSave }: { lead: LeadDetail['lead']; req: Record<string, string | number | null>; onSave: (body: Record<string, unknown>) => void }) {
  const [f, setF] = useState({
    serviceType: lead.serviceType ?? '',
    origin: String(req.origin ?? ''),
    destination: String(req.destination ?? ''),
    dateFrom: String(req.dateFrom ?? ''),
    dateTo: String(req.dateTo ?? ''),
    adults: String(req.adults ?? ''),
    children: String(req.children ?? ''),
    infants: String(req.infants ?? ''),
    budgetState: String(req.budgetState ?? ''),
    budgetAmount: String(req.budgetAmount ?? ''),
    budgetCurrency: String(req.budgetCurrency ?? 'USD'),
    contactOutcome: lead.contactOutcome ?? '',
    offerPrepDueAt: lead.offerPrepDueAt?.slice(0, 16) ?? '',
    lostReasonCode: lead.lostReasonCode ?? '',
    nextContactAt: lead.nextContactAt?.slice(0, 16) ?? '',
    followUpNote: lead.followUpNote ?? '',
    paymentDueAt: String(req.paymentDueAt ?? ''),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const num = (v: string) => (v === '' ? null : Number(v));
  const str = (v: string) => (v === '' ? null : v);
  return (
    <Section title="Talablar va lokal maydonlar">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            serviceType: str(f.serviceType),
            contactOutcome: str(f.contactOutcome),
            offerPrepDueAt: f.offerPrepDueAt ? new Date(f.offerPrepDueAt).toISOString() : null,
            lostReasonCode: str(f.lostReasonCode),
            nextContactAt: f.nextContactAt ? new Date(f.nextContactAt).toISOString() : null,
            followUpNote: str(f.followUpNote),
            requirements: {
              serviceType: str(f.serviceType),
              origin: str(f.origin),
              destination: str(f.destination),
              dateFrom: str(f.dateFrom),
              dateTo: str(f.dateTo),
              adults: num(f.adults),
              children: num(f.children),
              infants: num(f.infants),
              budgetState: str(f.budgetState),
              budgetAmount: str(f.budgetAmount),
              budgetCurrency: str(f.budgetCurrency),
              paymentDueAt: str(f.paymentDueAt),
            },
          });
        }}
      >
        <div className="row">
          <Field label="Xizmat turi">
            <select value={f.serviceType} onChange={set('serviceType')}>
              <option value="">—</option>
              <option value="avia">Avia</option>
              <option value="tour_package">Tur paket</option>
              <option value="hotel">Mehmonxona</option>
              <option value="visa">Viza</option>
              <option value="other">Boshqa</option>
            </select>
          </Field>
          <Field label="Qayerdan">
            <input value={f.origin} onChange={set('origin')} />
          </Field>
          <Field label="Qayerga">
            <input value={f.destination} onChange={set('destination')} />
          </Field>
        </div>
        <div className="row">
          <Field label="Ketish (dan)">
            <input type="date" value={f.dateFrom} onChange={set('dateFrom')} />
          </Field>
          <Field label="Qaytish (gacha)">
            <input type="date" value={f.dateTo} onChange={set('dateTo')} />
          </Field>
          <Field label="Katta">
            <input type="number" min={0} value={f.adults} onChange={set('adults')} />
          </Field>
          <Field label="Bola">
            <input type="number" min={0} value={f.children} onChange={set('children')} />
          </Field>
          <Field label="Chaqaloq">
            <input type="number" min={0} value={f.infants} onChange={set('infants')} />
          </Field>
        </div>
        <div className="row">
          <Field label="Budjet holati">
            <select value={f.budgetState} onChange={set('budgetState')}>
              <option value="">—</option>
              <option value="known">Ma’lum</option>
              <option value="undetermined">Aniqlanmagan</option>
            </select>
          </Field>
          <Field label="Budjet">
            <input value={f.budgetAmount} onChange={set('budgetAmount')} inputMode="decimal" />
          </Field>
          <Field label="Valyuta">
            <select value={f.budgetCurrency} onChange={set('budgetCurrency')}>
              <option>USD</option>
              <option>UZS</option>
              <option>EUR</option>
            </select>
          </Field>
        </div>
        <div className="row">
          <Field label="Aloqa natijasi">
            <input value={f.contactOutcome} onChange={set('contactOutcome')} />
          </Field>
          <Field label="Taklif muddati">
            <input type="datetime-local" value={f.offerPrepDueAt} onChange={set('offerPrepDueAt')} />
          </Field>
          <Field label="To‘lov muddati">
            <input type="date" value={f.paymentDueAt} onChange={set('paymentDueAt')} />
          </Field>
        </div>
        <div className="row">
          <Field label="Qayta aloqa vaqti">
            <input type="datetime-local" value={f.nextContactAt} onChange={set('nextContactAt')} />
          </Field>
          <Field label="Qayta aloqa izohi">
            <input value={f.followUpNote} onChange={set('followUpNote')} />
          </Field>
          <Field label="Bekor qilish sababi kodi">
            <input value={f.lostReasonCode} onChange={set('lostReasonCode')} />
          </Field>
        </div>
        <button className="btn" type="submit">
          Saqlash
        </button>
      </form>
    </Section>
  );
}

function OffersSection({ offers, onCreate, onSent, onAccept }: { offers: LeadDetail['offers']; onCreate: (b: Record<string, unknown>) => void; onSent: (id: string) => void; onAccept: (id: string) => void }) {
  const [content, setContent] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  return (
    <Section title="Takliflar (versiyalar o‘zgarmaydi)">
      {offers.map((o) => (
        <div key={o.id} className="card">
          <b>v{o.version}</b> — {o.amount} {o.currency} {o.sentAt ? <Badge tone="info">Yuborilgan {fmtDateTime(o.sentAt)}</Badge> : <Badge>Qoralama</Badge>} {o.acceptedAt && <Badge tone="ok">Tasdiqlangan</Badge>}
          <p>{o.content}</p>
          {!o.sentAt && (
            <button className="btn small" type="button" onClick={() => onSent(o.id)}>
              Yuborildi deb belgilash
            </button>
          )}
          {o.sentAt && !o.acceptedAt && (
            <button className="btn small" type="button" onClick={() => onAccept(o.id)}>
              Mijoz tasdiqladi
            </button>
          )}
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onCreate({ content, amount, currency });
          setContent('');
        }}
      >
        <Field label="Yangi versiya matni">
          <textarea value={content} onChange={(e) => setContent(e.target.value)} required />
        </Field>
        <div className="row">
          <Field label="Summa">
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required pattern="\d+(\.\d{1,2})?" />
          </Field>
          <Field label="Valyuta">
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option>USD</option>
              <option>UZS</option>
              <option>EUR</option>
            </select>
          </Field>
          <button className="btn" type="submit">
            Taklif versiyasini yaratish
          </button>
        </div>
      </form>
    </Section>
  );
}
