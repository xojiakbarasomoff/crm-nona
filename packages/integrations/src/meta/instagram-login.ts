import { requestJson, ProviderError, type FetchLike } from '../http';

/**
 * Instagram API with Instagram Login (Business Login for Instagram). This is NOT the Facebook Login path:
 * no Facebook Page, no Page access token, hosts are `www.instagram.com`, `api.instagram.com` and `graph.instagram.com`.
 * Sources: Meta developer docs "Instagram API with Instagram Login" (business login, messaging API), read 2026-10-25.
 * Nothing here has been verified against a live account yet.
 */

export const INSTAGRAM_MESSAGING_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'] as const;
/** Webhook fields this CRM consumes (Direct inbox only). */
export const INSTAGRAM_WEBHOOK_FIELDS = ['messages', 'messaging_seen'] as const;

export interface InstagramLoginConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  graphVersion: string;
}

export interface InstagramProfile {
  userId: string;
  /** `/me → id` (app-scoped); `user_id` dan farq qilsa — webhook shu ID bilan kelishi mumkin. */
  appScopedId: string | null;
  username: string | null;
  accountType: string | null;
}

export interface LongLivedToken {
  accessToken: string;
  expiresAt: Date;
}

/** `https://www.instagram.com/oauth/authorize` — the account owner authorizes in their own Instagram session. */
export function buildInstagramAuthorizeUrl(cfg: Pick<InstagramLoginConfig, 'appId' | 'redirectUri'>, state: string, scopes: readonly string[] = INSTAGRAM_MESSAGING_SCOPES): string {
  const q = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: scopes.join(','),
    state,
    // The Facebook-Login branch of the dialog is not wanted: this integration is Instagram Login only.
    enable_fb_login: '0',
    force_reauth: 'true',
  });
  return `https://www.instagram.com/oauth/authorize?${q.toString()}`;
}

type Json = Record<string, unknown>;

/** Authorization code (valid 1 hour, single use) → short-lived Instagram user token + IG user id. */
export async function exchangeInstagramCode(cfg: InstagramLoginConfig, code: string, fetchImpl: FetchLike = fetch): Promise<{ accessToken: string; userId: string; permissions: string[] }> {
  const body = new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.appSecret, grant_type: 'authorization_code', redirect_uri: cfg.redirectUri, code });
  const raw = await requestJson<Json>(
    'https://api.instagram.com/oauth/access_token',
    { method: 'POST', mutation: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
    fetchImpl,
  );
  // The docs show a `data` array; some responses are flat. Accept both, never guess a missing token.
  const row = (Array.isArray(raw.data) ? (raw.data as Json[])[0] : raw) as Json | undefined;
  const token = row && typeof row.access_token === 'string' ? row.access_token : null;
  const userId = row && (typeof row.user_id === 'string' || typeof row.user_id === 'number') ? String(row.user_id) : null;
  if (!token || !userId) throw new ProviderError('Instagram code exchange returned no token/user_id', 'validation', null);
  const permissions = row && typeof row.permissions === 'string' ? row.permissions.split(',') : Array.isArray(row?.permissions) ? (row!.permissions as string[]) : [];
  return { accessToken: token, userId, permissions };
}

/** Short-lived → long-lived (≈60 days). Server-side only (needs the app secret). */
export async function exchangeForLongLivedToken(cfg: Pick<InstagramLoginConfig, 'appSecret'>, shortToken: string, now: Date, fetchImpl: FetchLike = fetch): Promise<LongLivedToken> {
  const q = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: cfg.appSecret, access_token: shortToken });
  const raw = await requestJson<Json>(`https://graph.instagram.com/access_token?${q.toString()}`, {}, fetchImpl);
  return parseToken(raw, now);
}

/** Refresh a long-lived token (must be ≥24h old and not expired; unrefreshed tokens die after 60 days). */
export async function refreshLongLivedToken(token: string, now: Date, fetchImpl: FetchLike = fetch): Promise<LongLivedToken> {
  const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token });
  const raw = await requestJson<Json>(`https://graph.instagram.com/refresh_access_token?${q.toString()}`, {}, fetchImpl);
  return parseToken(raw, now);
}

function parseToken(raw: Json, now: Date): LongLivedToken {
  const token = typeof raw.access_token === 'string' ? raw.access_token : null;
  const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : Number(raw.expires_in);
  if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new ProviderError('Instagram token response is missing access_token/expires_in', 'validation', null);
  return { accessToken: token, expiresAt: new Date(now.getTime() + expiresIn * 1000) };
}

/** Professional account id + username + type (BUSINESS | MEDIA_CREATOR; PERSONAL accounts cannot use messaging). */
export async function fetchInstagramProfile(cfg: Pick<InstagramLoginConfig, 'graphVersion'>, token: string, fetchImpl: FetchLike = fetch): Promise<InstagramProfile> {
  const raw = await requestJson<Json>(`https://graph.instagram.com/${cfg.graphVersion}/me?fields=id,user_id,username,account_type`, { headers: { Authorization: `Bearer ${token}` } }, fetchImpl);
  const userId = typeof raw.user_id === 'string' || typeof raw.user_id === 'number' ? String(raw.user_id) : typeof raw.id === 'string' ? raw.id : null;
  if (!userId) throw new ProviderError('Instagram /me returned no user id', 'validation', null);
  return { userId, appScopedId: typeof raw.id === 'string' && raw.id !== userId ? raw.id : null, username: typeof raw.username === 'string' ? raw.username : null, accountType: typeof raw.account_type === 'string' ? raw.account_type : null };
}

/**
 * Enables webhook notifications for the authorizing account. Documented (Meta "Set up Instagram Webhooks", read
 * 2026-10-25): `POST https://graph.instagram.com/<ver>/<INSTAGRAM_ACCOUNT_ID>/subscribed_apps` with `subscribed_fields`
 * and `access_token` (an Instagram User access token); success = `{"success": true}`. The Unified-Login and
 * Facebook-Login variants use graph.facebook.com and are NOT used here.
 */
export async function subscribeInstagramWebhooks(cfg: Pick<InstagramLoginConfig, 'graphVersion'>, igUserId: string, token: string, fields: readonly string[] = INSTAGRAM_WEBHOOK_FIELDS, fetchImpl: FetchLike = fetch): Promise<boolean> {
  const q = new URLSearchParams({ subscribed_fields: fields.join(','), access_token: token });
  const raw = await requestJson<Json>(
    `https://graph.instagram.com/${cfg.graphVersion}/${encodeURIComponent(igUserId)}/subscribed_apps?${q.toString()}`,
    { method: 'POST', mutation: true },
    fetchImpl,
  );
  return raw.success === true;
}
