'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, fmtDateTime, useApi, type ApiError } from '../lib/api';
import { Async, Badge, FormError, Section } from './ui';

interface LeadAdsStatus {
  configured: boolean;
  oauthRedirectUri: string;
  pendingPages: Array<{ id: string; name: string; instagramUsername: string | null }>;
  connections: Array<{ id: string; pageName: string; pageId: string; state: string; formIds: string[]; verifiedWebhookAt: string | null; lastImportedAt: string | null; lastError: string | null }>;
}
interface Form { id: string; name: string; status: string | null }

const ERRORS: Record<string, string> = {
  LEAD_ADS_PERMISSION_MISSING: 'Facebook не предоставил все разрешения. Проверьте доступ к странице и лидам в Meta Business и подключитесь ещё раз.',
  LEAD_ADS_NO_PAGES: 'Нет доступных страниц Facebook. Подключитесь с аккаунтом, который управляет страницей NONA Travel.',
  OAUTH_STATE_INVALID: 'Ссылка авторизации устарела. Начните подключение заново.',
  LEAD_ADS_NOT_CONFIGURED: 'Администратору нужно завершить настройку подключения Meta.',
};

export function LeadAdsConnect({ onChange }: { onChange: () => Promise<void> }) {
  const status = useApi<LeadAdsStatus>('/api/v1/integrations/lead-ads/status', { pollMs: 10_000 });
  const [pageId, setPageId] = useState('');
  const forms = useApi<{ items: Form[] }>(pageId ? `/api/v1/integrations/lead-ads/forms?pageId=${encodeURIComponent(pageId)}` : null, { reset: true });
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const query = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search);
  const callback = query?.get('lead_ads');

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e as ApiError); } finally { setBusy(false); }
  };

  return <Section title="Рекламные формы Facebook и Instagram">
    <p className="muted">Подключите страницу Facebook, к которой относятся формы рекламы NONA Travel, и выберите формы. После отправки формы контакт, ответы и источник появятся в лидах CRM.</p>
    <FormError error={error} />
    {callback === 'denied' && <div className="state error">Разрешение Facebook не предоставлено. Формы не подключены.</div>}
    {callback === 'failed' && <div className="state error">{ERRORS[query?.get('reason') ?? ''] ?? 'Facebook не удалось подключить. Проверьте настройки приложения и доступ к странице, затем повторите подключение.'}</div>}
    {saved && <div className="state" role="status">Формы подключены, загрузка недавних заявок запланирована. Отправьте тестовую заявку через Meta и проверьте её в лидах.</div>}
    <Async state={status}>{s => <>
      {!s.configured && <div className="state error">Подключение рекламных форм ещё не настроено. Администратору нужно указать параметры Meta.</div>}
      {s.connections.map(c => <div className="state" key={c.id}>
        <b>{c.pageName}</b>{' '}<Badge tone={c.state === 'ready' ? 'ok' : c.state === 'problem' ? 'bad' : 'warn'}>{c.state === 'ready' ? 'Получение заявок проверено' : c.state === 'problem' ? 'Подключение требует внимания' : 'Ожидается тестовая заявка'}</Badge>
        <div className="muted">Форм: {c.formIds.length} · Последний импорт: {fmtDateTime(c.lastImportedAt)} · Проверка вебхука: {fmtDateTime(c.verifiedWebhookAt)}</div>
        {c.lastError && <p className="state error">{c.lastError}</p>}
      </div>)}
      <button className="btn" type="button" disabled={!s.configured || busy} onClick={() => void act(async () => {
        const r = await api<{ authorizeUrl: string }>('/api/v1/integrations/lead-ads/oauth/start', { method: 'POST' });
        window.location.href = r.authorizeUrl;
      })}>Подключить / переподключить формы через Facebook</button>
      {s.pendingPages.length > 0 && !saved && <div className="state">
        <label>Страница Facebook<select value={pageId} disabled={busy} onChange={e => { setPageId(e.target.value); setSelected([]); }}>
          <option value="">Выберите страницу NONA Travel</option>
          {s.pendingPages.map(p => <option key={p.id} value={p.id}>{p.name}{p.instagramUsername ? ` · @${p.instagramUsername}` : ''}</option>)}
        </select></label>
        {pageId && <Async state={forms}>{f => <>
          {!f.items.length && <p>На этой странице нет доступных рекламных форм. Создайте форму в Meta или проверьте доступ к ней.</p>}
          {f.items.length > 0 && <fieldset><legend>Формы, из которых принимать заявки</legend>{f.items.map(form => <label key={form.id} className="row">
            <input type="checkbox" checked={selected.includes(form.id)} disabled={busy} onChange={e => setSelected(prev => e.target.checked ? [...prev, form.id] : prev.filter(id => id !== form.id))} />
            {form.name}{form.status === 'ARCHIVED' ? ' (архивная)' : ''}
          </label>)}</fieldset>}
          <button className="btn" type="button" disabled={busy || !selected.length || forms.loading} onClick={() => void act(async () => {
            await api('/api/v1/integrations/lead-ads/connect', { method: 'POST', body: { pageId, formIds: selected } });
            setSaved(true);
            await status.reload();
            await onChange();
          })}>{busy ? 'Подключение…' : 'Принимать заявки из выбранных форм'}</button>
        </>}</Async>}
      </div>}
      <p><Link href="/leads">Открыть лиды</Link> — выберите источник «Instagram Lead Ads» или «Meta Lead Ads».</p>
      <p className="muted">Подключение Direct не подключает рекламные формы. До получения настоящего события отправка формы в CRM не считается проверенной.</p>
      <details className="help"><summary>Настройки для администратора</summary><p>В Meta App Dashboard настройте Facebook Login и Page webhook с полем leadgen. OAuth redirect URI: <code>{s.oauthRedirectUri}</code>. Webhook: <code>{typeof window === 'undefined' ? '' : window.location.origin}/webhooks/meta</code>.</p></details>
    </>}</Async>
  </Section>;
}
