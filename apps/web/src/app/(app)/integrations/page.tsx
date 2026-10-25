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
  checkpoints: Array<{ stream: string; lastRunAt: string | null; lastResult: unknown; cursor: unknown }>;
  retention: { status: string; confirmed?: boolean; rawWebhookDays?: number; technicalLogDays?: number; messageContentMonths?: number };
  slaBreachesOpen: number;
  attachmentsPendingScan: number;
  scanner: { name: string; kind: string };
  storage: { name: string; kind: string };
}

export default function IntegrationsPage() {
  const me = useMe();
  const state = useApi<Health>('/api/v1/integrations/health', { pollMs: 10_000 });
  const [error, setError] = useState<ApiError | null>(null);
  const [domain, setDomain] = useState('');
  const ig = useApi<{ configured: boolean; oauthRedirectUri: string; webhookCallbackPath: string; verifyTokenConfigured: boolean; signatureSecretConfigured: boolean; graphVersion: string | null; connections: Array<{ id: string; accountId: string; username: string | null; state: string; health: string; healthReason: string | null; verifiedInboundAt: string | null; verifiedOutboundAt: string | null; expiresAt: string | null }> }>('/api/v1/integrations/instagram/status');
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
            {canDo(me, 'integrations.manage') && (
              <Section title="Instagram Direct (Instagram API with Instagram Login)">
                <p className="muted">
                  Akkaunt egasi o‘z Instagram sessiyasida rasmiy ruxsat beradi; parol yoki token bu yerga kiritilmaydi. Instagram <b>professional</b> (Business/Creator) akkaunt kerak. Facebook Page talab qilinmaydi. Meta ilovasi Development rejimida yoki App Review’dan o‘tmaguncha faqat ilovaga qo‘shilgan test akkauntlar bilan ishlaydi — bu barcha mijozlar uchun tayyor integratsiya emas.
                </p>
                {ig.data && !ig.data.configured && <div className="state error">Sozlanmagan: INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET va META_GRAPH_VERSION kerak (docs/instagram-direct-setup.md).</div>}
                {ig.data && (
                  <ul className="hint">
                    <li>OAuth redirect URI: <code>{ig.data.oauthRedirectUri}</code></li>
                    <li>Webhook callback: <code>{typeof window === 'undefined' ? '' : window.location.origin}{ig.data.webhookCallbackPath}</code> · verify token: {ig.data.verifyTokenConfigured ? 'sozlangan' : 'YO‘Q'} · imzo siri: {ig.data.signatureSecretConfigured ? 'sozlangan' : 'YO‘Q'}</li>
                  </ul>
                )}
                {ig.data?.connections.map((c) => (
                  <div key={c.id} className="state">
                    <b>@{c.username ?? c.accountId}</b>{' '}
                    {c.state === 'ready' && <Badge tone="ok">Tayyor: kiruvchi va chiquvchi haqiqiy sinovdan o‘tgan</Badge>}
                    {c.state === 'inbound_verified' && <Badge tone="warn">Kiruvchi tasdiqlangan; chiquvchi javob sinovi kutilmoqda (tayyor emas)</Badge>}
                    {c.state === 'outbound_verified' && <Badge tone="warn">Chiquvchi tasdiqlangan; kiruvchi sinov kutilmoqda (tayyor emas)</Badge>}
                    {c.state === 'not_ready' && <Badge tone="warn">Ulangan, lekin haqiqiy sinov o‘tmagan — faol deb hisoblanmaydi</Badge>}
                    {c.state === 'problem' && <Badge tone="bad">Muammo: {c.healthReason}</Badge>}
                    {c.state === 'disconnected' && <Badge>Uzilgan</Badge>}
                    <div className="muted">Kiruvchi: {c.verifiedInboundAt ? fmtDateTime(c.verifiedInboundAt) : '—'} · Chiquvchi: {c.verifiedOutboundAt ? fmtDateTime(c.verifiedOutboundAt) : '—'} · Token muddati: {c.expiresAt ? fmtDateTime(c.expiresAt) : '—'}</div>
                  </div>
                ))}
                <button
                  className="btn"
                  type="button"
                  disabled={!ig.data?.configured}
                  onClick={() =>
                    void act(async () => {
                      const r = await api<{ authorizeUrl: string }>('/api/v1/integrations/instagram/oauth/start', { method: 'POST' });
                      window.location.href = r.authorizeUrl;
                    })
                  }
                >
                  Instagram akkauntni ulash / qayta ulash
                </button>
              </Section>
            )}
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
            <Section title="Sinxronlash va tarixni qayta olish">
              {canDo(me, 'integrations.manage') && (
                <div className="row">
                  <button className="btn secondary" type="button" onClick={() => act(() => api('/api/v1/integrations/amocrm/import', { method: 'POST' }))}>
                    amoCRM boshlang‘ich importi
                  </button>
                  <button className="btn secondary" type="button" onClick={() => act(() => api('/api/v1/integrations/lead-ads/backfill', { method: 'POST', body: {} }))}>
                    Lead Ads tarixini qayta olish
                  </button>
                </div>
              )}
              <table>
                <thead>
                  <tr>
                    <th>Oqim</th>
                    <th>Oxirgi ishga tushish</th>
                    <th>Natija</th>
                  </tr>
                </thead>
                <tbody>
                  {h.checkpoints.map((c) => (
                    <tr key={c.stream}>
                      <td>{c.stream}</td>
                      <td>{fmtDateTime(c.lastRunAt)}</td>
                      <td className="muted">
                        <code>{JSON.stringify(c.lastResult ?? c.cursor).slice(0, 200)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">Lead Ads: saqlanish oynasidan oldingi davr bo‘shliq sifatida ko‘rsatiladi — barcha eski lidlarni qaytarish va’da qilinmaydi.</p>
            </Section>
            <Section title="Xavfsizlik va saqlash">
              <p>
                Fayl skaneri: <Badge tone={h.scanner.kind === 'clamav' ? 'ok' : 'warn'}>{h.scanner.name}</Badge> · Saqlash: {h.storage.name} · Skan kutayotgan fayllar: {h.attachmentsPendingScan} · Ochiq SLA buzilishlari: {h.slaBreachesOpen}
              </p>
              <p>
                Retention:{' '}
                {h.retention.status === 'active' ? (
                  <Badge tone="ok">
                    Faol: webhook {h.retention.rawWebhookDays} kun, yozishma {h.retention.messageContentMonths} oy
                  </Badge>
                ) : (
                  <Badge tone="warn">Tasdiqlanmagan — tozalash o‘chirilgan</Badge>
                )}
              </p>
              {me.role === 'ADMIN' && h.retention.status !== 'active' && (
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() =>
                    window.confirm('Taklif etilgan muddatlarni (webhook 30 kun, texnik log 90 kun, yozishma 12 oy) kompaniya nomidan tasdiqlaysizmi?') &&
                    act(() => api('/api/v1/privacy/retention/confirm', { method: 'POST', body: { rawWebhookDays: 30, technicalLogDays: 90, messageContentMonths: 12 } }))
                  }
                >
                  Retention siyosatini tasdiqlash
                </button>
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
