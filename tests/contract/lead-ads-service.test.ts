import { describe, expect, it, vi } from 'vitest';
import { LEAD_ADS_SCOPES, type FetchLike } from '@crm/integrations';
import { LeadAdsService } from '../../apps/api/src/core/services/lead-ads.service';
import { loadConfig } from '../../apps/api/src/core/config';
import type { CoreDeps, UserActor } from '../../apps/api/src/core/context';

const admin = { type: 'user', id: 'admin', role: 'ADMIN', companyId: 'company', sessionId: 'session', email: '' } as UserActor;
const config = () => loadConfig({ APP_MODE: 'demo', DATABASE_URL: 'unused', REDIS_URL: 'unused', ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), SESSION_SECRET: 'a'.repeat(40), META_APP_ID: '1', META_APP_SECRET: 'test-secret', META_VERIFY_TOKEN: 'verify', META_GRAPH_VERSION: 'v23.0' });

function harness() {
  const states = new Map<string, Record<string, unknown>>();
  const cache = new Map<string, string>();
  let grant = true;
  const fetcher = vi.fn<FetchLike>(async input => {
    if (input.includes('/oauth/access_token')) return Response.json({ access_token: 'TEST_TOKEN' });
    if (input.includes('/me/permissions')) return Response.json({ data: (grant ? LEAD_ADS_SCOPES : []).map(permission => ({ permission, status: 'granted' })) });
    if (input.includes('/me/accounts')) return Response.json({ data: [{ id: '123', name: 'Nona', access_token: 'TEST_PAGE_TOKEN' }] });
    if (input.includes('/123/leadgen_forms')) return Response.json({ data: [{ id: '456', name: 'Form' }] });
    throw new Error('Unexpected API call');
  });
  const d = {
    config: config(), encryptionKey: Buffer.alloc(32), clock: { now: () => new Date('2026-10-25T12:00:00Z') },
    redis: { get: vi.fn(async (key: string) => cache.get(key) ?? null), set: vi.fn(async (key: string, value: string) => { cache.set(key, value); return 'OK'; }), del: vi.fn(async (key: string) => cache.delete(key)) },
    prisma: {
      oAuthState: {
        create: vi.fn(async ({ data }) => { const row = { id: data.stateHash, ...data }; states.set(data.stateHash, row); return row; }),
        findUnique: vi.fn(async ({ where }) => states.get(where.stateHash) ?? null),
        updateMany: vi.fn(async ({ where, data }) => { const row = states.get(where.id); if (!row || row.usedAt) return { count: 0 }; Object.assign(row, data); return { count: 1 }; }),
      },
      integrationConnection: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    },
  } as unknown as CoreDeps;
  const service = new LeadAdsService(d, fetcher);
  const start = async () => new URL((await service.start(admin)).authorizeUrl).searchParams.get('state')!;
  return { d, service, fetcher, states, cache, start, denyPermissions: () => { grant = false; } };
}

describe('Lead Ads OAuth security and setup validation', () => {
  it('rejects a state from another session before making any provider request', async () => {
    const h = harness(); const state = await h.start();
    await expect(h.service.callback({ ...admin, sessionId: 'other-session' }, { code: 'code', state })).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it('rejects expired and wrong-provider states', async () => {
    const h = harness(); const state = await h.start();
    const row = [...h.states.values()][0]!;
    row.expiresAt = new Date('2026-10-24');
    await expect(h.service.callback(admin, { code: 'code', state })).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    row.expiresAt = new Date('2026-10-26'); row.provider = 'META_DIRECT';
    await expect(h.service.callback(admin, { code: 'code', state })).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it('consumes OAuth state once, encrypts temporary Page tokens, and returns only safe choices', async () => {
    const h = harness(); const state = await h.start();
    await h.service.callback(admin, { code: 'code', state });
    await expect(h.service.callback(admin, { code: 'code', state })).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    expect([...h.cache.values()].join('')).not.toContain('TEST_PAGE_TOKEN');
    expect(h.d.redis.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'EX', 600);
    const status = await h.service.status(admin);
    expect(status.pendingPages).toEqual([{ id: '123', name: 'Nona', instagramUsername: null }]);
    expect(JSON.stringify(status)).not.toContain('TOKEN');
    expect((await h.service.status({ ...admin, sessionId: 'other' })).pendingPages).toEqual([]);
  });
  it('does not cache Page credentials when permissions are missing', async () => {
    const h = harness(); const state = await h.start(); h.denyPermissions();
    await expect(h.service.callback(admin, { code: 'code', state })).rejects.toMatchObject({ code: 'LEAD_ADS_PERMISSION_MISSING' });
    expect(h.cache.size).toBe(0);
  });
  it('refuses foreign Pages and forms before subscribing or saving any connection', async () => {
    const h = harness(); const state = await h.start(); await h.service.callback(admin, { code: 'code', state });
    await expect(h.service.connect(admin, { pageId: '999', formIds: ['456'] })).rejects.toMatchObject({ code: 'LEAD_ADS_PAGE_INVALID' });
    await expect(h.service.connect(admin, { pageId: '123', formIds: ['999'] })).rejects.toMatchObject({ code: 'LEAD_ADS_FORM_INVALID' });
    expect(h.fetcher.mock.calls.some(([url]) => url.includes('subscribed_apps'))).toBe(false);
  });
});
