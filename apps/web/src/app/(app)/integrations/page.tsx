'use client';

import { useState } from 'react';
import { api, fmtDateTime, useApi, type ApiError } from '../../../lib/api';
import { Async, Badge, Field, FormError, Section } from '../../../components/ui';
import { canDo, useMe } from '../../../components/shell';

interface Health {
  appMode: string;
  directChannelMode: string;
  adapters: Array<{ name: string; kind: string }>;
  connections: Array<{ id: string; provider: string; mode: string; accountId: string; accountDomain: string | null; health: string; healthReason: string | null; lastWebhookAt: string | null; lastSyncAt: string | null; lastError: string | null; disconnectedAt: string | null }>;
  inbox: Record<string, number>;
  outbox: Record<string, number>;
  oldestPendingInboxAgeSec: number;
  oldestPendingOutboxAgeSec: number;
  heartbeats: Array<{ name: string; lastBeatAt: string; ageSec: number }>;
  deadLetters: Array<{ id: string; action: string; lastError: string | null; attempts: number; updatedAt: string }>;
  needsOperator: Array<{ id: string; action: string; state: string; lastError: string | null; updatedAt: string }>;
  metrics: Record<string, number>;
  overdueReminders: number;
}

export default function IntegrationsPage() {
  const me = useMe();
  const state = useApi<Health>('/api/v1/integrations/health', { pollMs: 10_000 });
  const [error, setError] = useState<ApiError | null>(null);
  const [domain, setDomain] = useState('');
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await state.reload();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  return (
    <>
      <h1>Integratsiyalar</h1>
      <FormError error={error} />
      <Async state={state}>
        {(h) => (
          <>
            <Section title="Adapterlar">
              <p>
                Rejim: <b>{h.appMode}</b> · Direct kanali: <b>{h.directChannelMode}</b>
              </p>
              {h.adapters.map((a) => (
                <Badge key={a.name} tone={a.kind === 'mock' ? 'warn' : a.kind === 'live' ? 'ok' : 'neutral'}>
                  {a.name} ({a.kind === 'mock' ? 'DEMO' : a.kind})
                </Badge>
              ))}
              {h.appMode === 'demo' && <p className="muted">Demo adapterlar real integratsiya ishlaganini isbotlamaydi. Live holat: docs/feasibility.md.</p>}
            </Section>
            <Section title="Ulanishlar">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Akkaunt</th>
                      <th>Holat</th>
                      <th>Oxirgi webhook</th>
                      <th>Oxirgi sync</th>
                      <th>Xato</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {h.connections.map((c) => (
                      <tr key={c.id}>
                        <td>
                          {c.provider} <Badge>{c.mode}</Badge>
                        </td>
                        <td>{c.accountDomain ?? c.accountId}</td>
                        <td>
                          <Badge tone={c.health === 'ok' ? 'ok' : 'bad'}>{c.health}</Badge> <span className="muted">{c.healthReason}</span>
                        </td>
                        <td>{fmtDateTime(c.lastWebhookAt)}</td>
                        <td>{fmtDateTime(c.lastSyncAt)}</td>
                        <td className="muted">{c.lastError ?? '—'}</td>
                        <td>
                          {canDo(me, 'integrations.manage') && !c.disconnectedAt && (
                            <button className="btn small danger" type="button" onClick={() => window.confirm('Ulanishni uzasizmi? Yangi API ishlari pauzaga olinadi.') && act(() => api(`/api/v1/integrations/${c.id}/disconnect`, { method: 'POST' }))}>
                              Uzish
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {canDo(me, 'integrations.manage') && (
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                      const r = await api<{ authorizeUrl: string }>('/api/v1/integrations/amocrm/oauth/start', { method: 'POST', body: { domain } });
                      window.location.href = r.authorizeUrl;
                    });
                  }}
                >
                  <Field label="amoCRM domeni (allowlist)">
                    <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="kompaniya.amocrm.ru" required />
                  </Field>
                  <button className="btn" type="submit">
                    amoCRM’ni ulash / qayta ulash
                  </button>
                </form>
              )}
            </Section>
            <Section title="Navbatlar va monitoring">
              <div className="grid">
                <div className="kpi">
                  <div className="label">Inbox</div>
                  <div className="value">{JSON.stringify(h.inbox)}</div>
                  <div className="muted">Eng eski kutayotgan: {h.oldestPendingInboxAgeSec} s</div>
                </div>
                <div className="kpi">
                  <div className="label">Outbox</div>
                  <div className="value">{JSON.stringify(h.outbox)}</div>
                  <div className="muted">Eng eski kutayotgan: {h.oldestPendingOutboxAgeSec} s</div>
                </div>
                <div className="kpi">
                  <div className="label">Kechikkan eslatmalar</div>
                  <div className="value">{h.overdueReminders}</div>
                </div>
                {h.heartbeats.map((b) => (
                  <div className="kpi" key={b.name}>
                    <div className="label">Heartbeat: {b.name}</div>
                    <div className="value">
                      <Badge tone={b.ageSec < 90 ? 'ok' : 'bad'}>{b.ageSec} s oldin</Badge>
                    </div>
                  </div>
                ))}
              </div>
              <p className="muted">
                {Object.entries(h.metrics)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(' · ')}
              </p>
            </Section>
            <Section title="Operator ko‘rigi talab etiladi (unknown / paused / dead)">
              {[...h.needsOperator, ...h.deadLetters.map((d) => ({ ...d, state: 'dead' }))].length === 0 ? (
                <div className="state empty">Yo‘q</div>
              ) : (
                <table>
                  <tbody>
                    {[...h.needsOperator, ...h.deadLetters.map((d) => ({ ...d, state: 'dead' }))].map((o) => (
                      <tr key={o.id}>
                        <td>{o.action}</td>
                        <td>
                          <Badge tone="bad">{o.state}</Badge>
                        </td>
                        <td className="muted">{o.lastError}</td>
                        <td>{fmtDateTime(o.updatedAt)}</td>
                        <td>
                          {canDo(me, 'integrations.replay') && (
                            <button className="btn small" type="button" onClick={() => act(() => api(`/api/v1/integrations/replay/${o.id}`, { method: 'POST' }))}>
                              Xavfsiz replay
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
            {h.appMode === 'demo' && canDo(me, 'integrations.manage') && <DemoTools onDone={() => state.reload()} />}
          </>
        )}
      </Async>
    </>
  );
}

function DemoTools({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<ApiError | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const fire = async (path: string, body: unknown) => {
    setError(null);
    try {
      const r = await api(path, { method: 'POST', body });
      setMsg(JSON.stringify(r));
      onDone();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  return (
    <Section title="DEMO simulyatorlari (faqat demo rejimida)">
      <p className="muted">Bu tugmalar haqiqiy webhook yo‘li orqali sun’iy hodisa yuboradi. Real Meta yoki amoCRM bilan bog‘lanmaydi.</p>
      <div className="row">
        <button className="btn secondary" type="button" onClick={() => fire('/api/v1/demo/lead-ads', { fullName: `Demo Mijoz ${Math.floor(Math.random() * 1000)}`, phone: `+99890${Math.floor(1000000 + Math.random() * 8999999)}`, destination: 'Dubay', platform: 'ig', adId: '120000000000001' })}>
          Lead Ads formasi
        </button>
        <button className="btn secondary" type="button" onClick={() => fire('/api/v1/demo/direct', { scopedSenderId: `99${Date.now()}`, text: 'Salom, Istanbulga tur bormi?' })}>
          Direct xabar
        </button>
        <button className="btn secondary" type="button" onClick={() => fire('/api/v1/demo/fail-next', { target: 'amo', failure: 'rate_limited' })}>
          Keyingi amoCRM so‘rovi 429
        </button>
      </div>
      <FormError error={error} />
      {msg && <pre className="muted">{msg}</pre>}
    </Section>
  );
}
