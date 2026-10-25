import { describe, expect, it, vi } from 'vitest';
import { buildLeadAdsAuthorizeUrl, LEAD_ADS_SCOPES, LeadAdsLoginClient, type FetchLike } from '@crm/integrations';
import { buildAdapters, metaLeadsFor } from '../../apps/api/src/core/adapters';
import { loadConfig } from '../../apps/api/src/core/config';
import type { Redis } from 'ioredis';

const cfg = { appId: '1234', appSecret: 'test-secret', graphVersion: 'v23.0', redirectUri: 'https://crm.example.test/api/v1/integrations/lead-ads/oauth/callback' };
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

describe('Facebook Login for Lead Ads (contract, not live-account verification)', () => {
  it('uses Facebook Login with separate Page permissions and state', () => {
    const u = new URL(buildLeadAdsAuthorizeUrl(cfg, 'one-time-state'));
    expect(u.origin).toBe('https://www.facebook.com');
    expect(u.searchParams.get('scope')?.split(',')).toEqual([...LEAD_ADS_SCOPES]);
    expect(u.searchParams.get('state')).toBe('one-time-state');
    expect(u.searchParams.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(u.toString()).not.toContain(cfg.appSecret);
  });

  it('Facebook Login for Business: config_id replaces scope', () => {
    const u = new URL(buildLeadAdsAuthorizeUrl({ ...cfg, configId: '1446647680762146' }, 's'));
    expect(u.searchParams.get('config_id')).toBe('1446647680762146');
    expect(u.searchParams.has('scope')).toBe(false);
    expect(u.searchParams.get('response_type')).toBe('code');
  });

  it('exchanges the code for a long-lived user token', async () => {
    const calls: URL[] = [];
    const client = new LeadAdsLoginClient(cfg, async input => {
      const u = new URL(input); calls.push(u);
      return json({ access_token: u.searchParams.has('code') ? 'short' : 'long' });
    });
    expect(await client.exchangeCode('auth-code')).toBe('long');
    expect(calls[0]?.searchParams.get('code')).toBe('auth-code');
    expect(calls[1]?.searchParams.get('grant_type')).toBe('fb_exchange_token');
    expect(calls[1]?.searchParams.get('fb_exchange_token')).toBe('short');
  });

  it('paginates Pages by cursor without following untrusted paging URLs', async () => {
    const calls: string[] = [];
    const client = new LeadAdsLoginClient(cfg, async (input, init) => {
      calls.push(input);
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer user-token' });
      return input.includes('after=cursor2') ? json({ data: [{ id: '2', name: 'Nona', access_token: 'page-2', instagram_business_account: { username: 'nonatravel.uz' } }] }) : json({ data: [{ id: '1', name: 'Other', access_token: 'page-1' }], paging: { next: 'https://untrusted.invalid/', cursors: { after: 'cursor2' } } });
    });
    expect(await client.pages('user-token')).toMatchObject([{ id: '1' }, { id: '2', instagramUsername: 'nonatravel.uz' }]);
    expect(calls).toHaveLength(2);
    expect(calls.every(u => new URL(u).origin === 'https://graph.facebook.com')).toBe(true);
  });

  it('fails closed on an incomplete permission/collection response or repeated cursor', async () => {
    await expect(new LeadAdsLoginClient(cfg, async () => json({})).permissions('token')).rejects.toThrow('collection');
    await expect(new LeadAdsLoginClient(cfg, async () => json({ data: [], paging: { next: 'x', cursors: { after: 'same' } } })).forms('1', 'token')).rejects.toThrow('cursor');
  });

  it('preserves the existing subscription fields and verifies leadgen after subscribing', async () => {
    let subscribed = false;
    const client = new LeadAdsLoginClient(cfg, async (input, init) => {
      expect(input).toContain('/1/subscribed_apps?');
      if (init?.method === 'POST') {
        expect(new URLSearchParams(init.body as string).get('subscribed_fields')).toBe('messages,leadgen');
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer page-token' });
        subscribed = true;
        return json({ success: true });
      }
      return json({ data: [{ id: '1234', subscribed_fields: subscribed ? ['messages', 'leadgen'] : ['messages'] }] });
    });
    await client.subscribe('1', 'page-token');
    expect(subscribed).toBe(true);
  });

  it('does not report success if the subscription cannot be read back', async () => {
    const fetcher: FetchLike = async (_input, init) => init?.method === 'POST' ? json({ success: true }) : json({ data: [] });
    await expect(new LeadAdsLoginClient(cfg, fetcher).subscribe('1', 'page-token')).rejects.toThrow('not confirmed');
  });
});

describe('mixed-mode Lead Ads routing', () => {
  const config = () => loadConfig({ APP_MODE: 'demo', DATABASE_URL: 'postgresql://unused', REDIS_URL: 'redis://unused', ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), SESSION_SECRET: 'a'.repeat(40), META_GRAPH_VERSION: 'v23.0' });
  it('routes live Pages to the real Graph adapter while leaving demo Pages synthetic', async () => {
    const fetcher = vi.fn<FetchLike>(async () => json({ id: '9', form_id: '8', field_data: [{ name: 'full_name', values: ['Test'] }] }));
    const adapters = buildAdapters(config(), {} as Redis, fetcher);
    expect(metaLeadsFor(adapters, 'demo').descriptor.kind).toBe('mock');
    expect(metaLeadsFor(adapters, 'live').descriptor.kind).toBe('live');
    await metaLeadsFor(adapters, 'live').fetchLead('9', 'real-page-token');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer real-page-token' });
  });
  it('never falls back to demo when the live adapter is missing', () => {
    const c = config(); c.meta.graphVersion = '';
    expect(() => metaLeadsFor(buildAdapters(c, {} as Redis), 'live')).toThrow('No matching');
  });
});
