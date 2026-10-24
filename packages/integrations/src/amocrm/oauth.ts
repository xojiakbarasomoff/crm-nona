import { createHash, randomBytes } from 'node:crypto';
import { requestJson, type FetchLike } from '../http';

/**
 * amoCRM REST OAuth 2.0 ([S02]). This is unrelated to the Chats API channel auth ([S03]).
 * Tokens: `expires_in` is honoured (never hard-coded); refresh tokens rotate on every refresh so
 * parallel workers must never reuse an old refresh token (core holds a per-connection DB lock).
 */

export interface AmoTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tokenType: string;
}

export interface AmoOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedDomains: string[];
}

const DOMAIN_RE = /^[a-z0-9-]+\.(amocrm\.ru|amocrm\.com|kommo\.com)$/;

/** Rejects any account domain not on the explicit allowlist (TZ §19.4). */
export function assertAllowedDomain(domain: string, allowed: string[]): string {
  const d = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!DOMAIN_RE.test(d)) throw new Error('Account domain is not a recognised amoCRM domain');
  if (!allowed.map((a) => a.toLowerCase()).includes(d)) throw new Error('Account domain is not in AMO_ALLOWED_DOMAINS');
  return d;
}

export function newOAuthState(): { state: string; stateHash: string } {
  const state = randomBytes(32).toString('base64url');
  return { state, stateHash: hashState(state) };
}

export function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

export function buildAuthorizeUrl(cfg: AmoOAuthConfig, state: string): string {
  const u = new URL('https://www.amocrm.ru/oauth');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('state', state);
  u.searchParams.set('mode', 'post_message');
  return u.toString();
}

interface TokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
  refresh_token: string;
}

function toTokenSet(r: TokenResponse, now: Date): AmoTokenSet {
  if (!r?.access_token || !r.refresh_token || typeof r.expires_in !== 'number') throw new Error('Malformed token response');
  return { accessToken: r.access_token, refreshToken: r.refresh_token, tokenType: r.token_type, expiresAt: new Date(now.getTime() + r.expires_in * 1000) };
}

export async function exchangeCode(cfg: AmoOAuthConfig, domain: string, code: string, fetchImpl: FetchLike = fetch, now = new Date()): Promise<AmoTokenSet> {
  const d = assertAllowedDomain(domain, cfg.allowedDomains);
  const r = await requestJson<TokenResponse>(
    `https://${d}/oauth2/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri }),
    },
    fetchImpl,
  );
  return toTokenSet(r, now);
}

export async function refreshTokens(cfg: AmoOAuthConfig, domain: string, refreshToken: string, fetchImpl: FetchLike = fetch, now = new Date()): Promise<AmoTokenSet> {
  const d = assertAllowedDomain(domain, cfg.allowedDomains);
  const r = await requestJson<TokenResponse>(
    `https://${d}/oauth2/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken, redirect_uri: cfg.redirectUri }),
    },
    fetchImpl,
  );
  return toTokenSet(r, now);
}
