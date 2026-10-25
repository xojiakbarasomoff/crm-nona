import { ProviderError, requestJson, type FetchLike } from '../http';

export interface LeadAdsLoginConfig {
  appId: string;
  appSecret: string;
  graphVersion: string;
  redirectUri: string;
}

// Lead Ads uses Facebook Login and Page tokens, independently of Instagram Login for Direct.
export const LEAD_ADS_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'leads_retrieval', 'ads_management'] as const;
export interface LeadAdsPage {
  id: string;
  name: string;
  accessToken: string;
  instagramUsername: string | null;
}
export interface LeadAdsForm { id: string; name: string; status: string | null }
type Json = Record<string, unknown>;

export function buildLeadAdsAuthorizeUrl(c: LeadAdsLoginConfig, state: string): string {
  const u = new URL(`https://www.facebook.com/${c.graphVersion}/dialog/oauth`);
  u.search = new URLSearchParams({ client_id: c.appId, redirect_uri: c.redirectUri, state, response_type: 'code', scope: LEAD_ADS_SCOPES.join(','), auth_type: 'rerequest' }).toString();
  return u.toString();
}

/** Tokens never leave the backend; cursor URLs supplied by Meta are never followed. */
export class LeadAdsLoginClient {
  constructor(private readonly c: LeadAdsLoginConfig, private readonly fetchImpl: FetchLike = fetch) {}

  private url(path: string, params: Record<string, string> = {}) {
    return `https://graph.facebook.com/${this.c.graphVersion}/${path}?${new URLSearchParams(params)}`;
  }

  async exchangeCode(code: string): Promise<string> {
    const short = await requestJson<Json>(this.url('oauth/access_token', { client_id: this.c.appId, client_secret: this.c.appSecret, redirect_uri: this.c.redirectUri, code }), {}, this.fetchImpl);
    if (typeof short.access_token !== 'string' || !short.access_token) throw new ProviderError('Facebook did not return an access token', 'validation', null);
    const long = await requestJson<Json>(this.url('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: this.c.appId, client_secret: this.c.appSecret, fb_exchange_token: short.access_token }), {}, this.fetchImpl);
    if (typeof long.access_token !== 'string' || !long.access_token) throw new ProviderError('Facebook did not return a long-lived token', 'validation', null);
    return long.access_token;
  }

  private async list(path: string, token: string, fields: string): Promise<Json[]> {
    const rows: Json[] = [];
    let after: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const raw = await requestJson<Json>(this.url(path, { ...(fields ? { fields } : {}), limit: '100', ...(after ? { after } : {}) }), { headers: { Authorization: `Bearer ${token}` } }, this.fetchImpl);
      if (!Array.isArray(raw.data)) throw new ProviderError('Meta did not return a collection', 'transient', null);
      rows.push(...raw.data as Json[]);
      const paging = raw.paging as { next?: unknown; cursors?: { after?: unknown } } | undefined;
      if (!paging?.next) return rows;
      const next = paging.cursors?.after;
      if (typeof next !== 'string' || !next || seen.has(next)) throw new ProviderError('Invalid Meta pagination cursor', 'transient', null);
      seen.add(next);
      after = next;
    }
    throw new ProviderError('Meta collection exceeds the supported page limit', 'validation', null);
  }

  async permissions(token: string): Promise<string[]> {
    return (await this.list('me/permissions', token, '')).filter(r => r.status === 'granted' && typeof r.permission === 'string').map(r => r.permission as string);
  }

  async pages(token: string): Promise<LeadAdsPage[]> {
    return (await this.list('me/accounts', token, 'id,name,access_token')).flatMap(r => {
      if (typeof r.id !== 'string' || typeof r.access_token !== 'string' || !r.access_token) return [];
      const ig = r.instagram_business_account as Json | undefined;
      return [{ id: r.id, name: typeof r.name === 'string' ? r.name : r.id, accessToken: r.access_token, instagramUsername: typeof ig?.username === 'string' ? ig.username : null }];
    });
  }

  async forms(pageId: string, token: string): Promise<LeadAdsForm[]> {
    return (await this.list(`${encodeURIComponent(pageId)}/leadgen_forms`, token, 'id,name,status')).flatMap(r => typeof r.id === 'string' ? [{ id: r.id, name: typeof r.name === 'string' ? r.name : r.id, status: typeof r.status === 'string' ? r.status : null }] : []);
  }

  async subscribe(pageId: string, token: string): Promise<void> {
    const path = `${encodeURIComponent(pageId)}/subscribed_apps`;
    const before = await this.list(path, token, 'id,subscribed_fields');
    const ours = before.find(r => r.id === this.c.appId);
    const existing = Array.isArray(ours?.subscribed_fields) ? ours.subscribed_fields.filter((x): x is string => typeof x === 'string') : [];
    const subscribed_fields = [...new Set([...existing, 'leadgen'])].join(',');
    const r = await requestJson<Json>(this.url(path), { method: 'POST', mutation: true, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ subscribed_fields }).toString() }, this.fetchImpl);
    if (r.success !== true) throw new ProviderError('Meta did not confirm the Page subscription', 'validation', null);
    const after = await this.list(path, token, 'id,subscribed_fields');
    if (!after.some(r => r.id === this.c.appId && Array.isArray(r.subscribed_fields) && r.subscribed_fields.includes('leadgen'))) throw new ProviderError('Lead Ads webhook subscription is not confirmed', 'validation', null);
  }
}
