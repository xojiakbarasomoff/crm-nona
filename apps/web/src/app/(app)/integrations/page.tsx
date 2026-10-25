'use client';

import { useState } from 'react';
import { api, fmtDateTime, useApi, type ApiError } from '../../../lib/api';
import { Async, Badge, FormError, Section } from '../../../components/ui';
import { canDo, useMe } from '../../../components/shell';

interface Health {
  appMode: string;
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
  retention: { status: string; confirmed?: boolean; rawWebhookDays?: number; technicalLogDays?: number; messageContentMonths?: number };
  slaBreachesOpen: number;
  attachmentsPendingScan: number;
  scanner: { name: string; kind: string };
  storage: { name: string; kind: string };
}

const PROVIDER_LABEL: Record<string, string> = { META_DIRECT: 'Instagram Direct', META_LEADS: 'Рекламные формы (Lead Ads)' };
const HEALTH_LABEL: Record<string, string> = { ok: 'Работает', degraded: 'Ограничено', paused: 'Приостановлено', disconnected: 'Отключено', down: 'Не работает' };
const REASON_LABEL: Record<string, string> = { awaiting_live_verification: 'ожидается проверка ответа', webhook_subscription_unconfirmed: 'подписка не подтверждена', token_refresh_failed: 'токен не обновился', disconnected_by_admin: 'отключено администратором' };
const OP_STATE_LABEL: Record<string, string> = { unknown: 'результат неизвестен', paused: 'приостановлено', dead: 'остановлено' };

export default function IntegrationsPage() {
  const me = useMe();
  const state = useApi<Health>('/api/v1/integrations/health', { pollMs: 10_000 });
  const [error, setError] = useState<ApiError | null>(null);
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
      <h1>Интеграции</h1>
      <FormError error={error} />
      <Async state={state}>
        {(h) => (
          <>
            <Section title="Подключения">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Подключение</th>
                      <th>Аккаунт</th>
                      <th>Состояние</th>
                      <th>Последнее сообщение</th>
                      <th>Ошибка</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {h.connections.map((c) => (
                      <tr key={c.id}>
                        <td>
                          {PROVIDER_LABEL[c.provider] ?? c.provider} {c.mode === 'demo' && <Badge tone="warn">демо</Badge>}
                        </td>
                        <td>{c.accountDomain ?? c.accountId}</td>
                        <td>
                          {c.mode === 'demo' ? (
                            <Badge tone="warn">Демо — реального подключения нет</Badge>
                          ) : (
                            <>
                              <Badge tone={c.health === 'ok' ? 'ok' : 'warn'}>{HEALTH_LABEL[c.health] ?? c.health}</Badge> <span className="muted">{c.healthReason ? REASON_LABEL[c.healthReason] ?? c.healthReason : ''}</span>
                            </>
                          )}
                        </td>
                        <td>{fmtDateTime(c.lastWebhookAt)}</td>
                        <td className="muted">{c.lastError ?? '—'}</td>
                        <td>
                          {canDo(me, 'integrations.manage') && !c.disconnectedAt && (
                            <button className="btn small danger" type="button" onClick={() => window.confirm('Отключить подключение? Приём новых событий будет приостановлен.') && act(() => api(`/api/v1/integrations/${c.id}/disconnect`, { method: 'POST' }))}>
                              Отключить
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
            {canDo(me, 'integrations.manage') && (
              <Section title="Instagram Direct">
                <p className="muted">
                  Владелец аккаунта компании даёт разрешение в окне Instagram; пароль сюда не вводится. Нужен профессиональный аккаунт (Business/Creator).
                </p>
                {ig.data && !ig.data.configured && <div className="state error">Подключение Instagram не настроено: администратору нужно указать настройки.</div>}
                {ig.data && (
                  <details className="help">
                    <summary>Технические настройки</summary>
                    <ul className="hint">
                      <li>
                        OAuth redirect URI: <code>{ig.data.oauthRedirectUri}</code>
                      </li>
                      <li>
                        Адрес вебхука: <code>{typeof window === 'undefined' ? '' : window.location.origin}{ig.data.webhookCallbackPath}</code> · verify token: {ig.data.verifyTokenConfigured ? 'настроен' : 'НЕТ'} · секрет подписи: {ig.data.signatureSecretConfigured ? 'настроен' : 'НЕТ'}
                      </li>
                    </ul>
                  </details>
                )}
                {ig.data?.connections.map((c) => (
                  <div key={c.id} className="state">
                    <b>@{c.username ?? c.accountId}</b>{' '}
                    {c.state === 'ready' && <Badge tone="ok">Подключено: входящие и ответы проверены</Badge>}
                    {c.state === 'inbound_verified' && <Badge tone="warn">Входящие сообщения подключены · отправка ответов не подключена</Badge>}
                    {c.state === 'outbound_verified' && <Badge tone="warn">Отправка ответов проверена · проверка входящих ожидается</Badge>}
                    {c.state === 'not_ready' && <Badge tone="warn">Подключено, проверка ожидается</Badge>}
                    {c.state === 'problem' && <Badge tone="bad">Проблема: {c.healthReason ? REASON_LABEL[c.healthReason] ?? c.healthReason : ''}</Badge>}
                    {c.state === 'disconnected' && <Badge>Отключено</Badge>}
                    <div className="muted">Входящие: {c.verifiedInboundAt ? fmtDateTime(c.verifiedInboundAt) : '—'} · Исходящие: {c.verifiedOutboundAt ? fmtDateTime(c.verifiedOutboundAt) : '—'} · Токен действует до: {c.expiresAt ? fmtDateTime(c.expiresAt) : '—'}</div>
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
                  Подключить / переподключить аккаунт Instagram
                </button>
              </Section>
            )}
            <Section title="Безопасность и хранение">
              <p>
                Проверка файлов: <Badge tone={h.scanner.kind === 'clamav' ? 'ok' : 'warn'}>{h.scanner.name}</Badge> · Хранилище: {h.storage.name} · Файлов ожидают проверки: {h.attachmentsPendingScan} · Открытых нарушений срока ответа: {h.slaBreachesOpen}
              </p>
              <p>
                Политика хранения:{' '}
                {h.retention.status === 'active' ? (
                  <Badge tone="ok">
                    Действует: вебхуки {h.retention.rawWebhookDays} дн., переписка {h.retention.messageContentMonths} мес.
                  </Badge>
                ) : (
                  <Badge tone="warn">Не утверждена — очистка выключена</Badge>
                )}
              </p>
              {me.role === 'ADMIN' && h.retention.status !== 'active' && (
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() =>
                    window.confirm('Утвердить предложенные сроки (вебхуки 30 дней, технические журналы 90 дней, переписка 12 месяцев) от имени компании?') &&
                    act(() => api('/api/v1/privacy/retention/confirm', { method: 'POST', body: { rawWebhookDays: 30, technicalLogDays: 90, messageContentMonths: 12 } }))
                  }
                >
                  Утвердить политику хранения
                </button>
              )}
            </Section>
            {canDo(me, 'integrations.manage') && (
              <details className="admin-diag">
                <summary>Диагностика администратора</summary>
                <Section title="Адаптеры">
                  <p>
                    Режим: <b>{h.appMode}</b>
                  </p>
                  {h.adapters.map((a) => (
                    <Badge key={a.name} tone={a.kind === 'mock' ? 'warn' : a.kind === 'live' ? 'ok' : 'neutral'}>
                      {a.name} ({a.kind === 'mock' ? 'ДЕМО' : a.kind})
                    </Badge>
                  ))}
                  {h.appMode === 'demo' && <p className="muted">Демо-адаптеры не доказывают, что реальная интеграция работает.</p>}
                </Section>
                <Section title="Очереди и мониторинг">
                  <div className="grid">
                    <div className="kpi">
                      <div className="label">Входящие события</div>
                      <div className="value">{JSON.stringify(h.inbox)}</div>
                      <div className="muted">Самое старое ожидающее: {h.oldestPendingInboxAgeSec} с</div>
                    </div>
                    <div className="kpi">
                      <div className="label">Исходящие операции</div>
                      <div className="value">{JSON.stringify(h.outbox)}</div>
                      <div className="muted">Самая старая ожидающая: {h.oldestPendingOutboxAgeSec} с</div>
                    </div>
                    <div className="kpi">
                      <div className="label">Просроченные напоминания</div>
                      <div className="value">{h.overdueReminders}</div>
                    </div>
                    {h.heartbeats.map((b) => (
                      <div className="kpi" key={b.name}>
                        <div className="label">Пульс: {b.name}</div>
                        <div className="value">
                          <Badge tone={b.ageSec < 90 ? 'ok' : 'bad'}>{b.ageSec} с назад</Badge>
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
                <Section title="Требуют проверки оператором (неизвестно / приостановлено / остановлено)">
                  {[...h.needsOperator, ...h.deadLetters.map((d) => ({ ...d, state: 'dead' }))].length === 0 ? (
                    <div className="state empty">Нет</div>
                  ) : (
                    <table>
                      <tbody>
                        {[...h.needsOperator, ...h.deadLetters.map((d) => ({ ...d, state: 'dead' }))].map((o) => (
                          <tr key={o.id}>
                            <td>{o.action}</td>
                            <td>
                              <Badge tone="bad">{OP_STATE_LABEL[o.state] ?? o.state}</Badge>
                            </td>
                            <td className="muted">{o.lastError}</td>
                            <td>{fmtDateTime(o.updatedAt)}</td>
                            <td>
                              {canDo(me, 'integrations.replay') && (
                                <button className="btn small" type="button" onClick={() => act(() => api(`/api/v1/integrations/replay/${o.id}`, { method: 'POST' }))}>
                                  Безопасный повтор
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Section>
                <Section title="Повторное получение истории">
                  <div className="row">
                    <button className="btn secondary" type="button" onClick={() => act(() => api('/api/v1/integrations/lead-ads/backfill', { method: 'POST', body: {} }))}>
                      Повторно получить историю Lead Ads
                    </button>
                  </div>
                  <p className="muted">Lead Ads: период до окна хранения показывается как пробел — возврат всех старых лидов не обещается.</p>
                </Section>
              </details>
            )}
          </>
        )}
      </Async>
    </>
  );
}
