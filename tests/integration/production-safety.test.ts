import { afterAll, describe, expect, it } from 'vitest';
import { assertProductionSafety } from '../../apps/api/src/core';
import { DEMO_PASSWORD } from '../../packages/database/src/seed';
import { makeCore } from './helpers';

const staging = makeCore({ env: { APP_MODE: 'staging', COOKIE_SECURE: 'true', META_GRAPH_VERSION: 'v-test', AMO_CHAT_CHANNEL_ID: 'test-channel', SCANNER: 'clamav' } });
const demo = makeCore();

afterAll(async () => {
  await staging.close();
  await demo.close();
});

describe('demo credentials never work outside demo mode (TZ §25.1)', () => {
  it('demo login works in demo mode', async () => {
    const r = await demo.auth.login({ email: 'menejer.a@demo.local', password: DEMO_PASSWORD, ip: '10.0.0.1', userAgent: null });
    expect(r.token).toBeTruthy();
  });

  it('the same demo account is rejected in staging with the generic error', async () => {
    await expect(staging.auth.login({ email: 'menejer.a@demo.local', password: DEMO_PASSWORD, ip: '10.0.0.2', userAgent: null })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
  });

  it('API/worker refuse to start in staging while demo accounts or demo connections exist', async () => {
    await expect(assertProductionSafety(staging)).rejects.toThrow(/demo account/);
    await expect(assertProductionSafety(demo)).resolves.toBeUndefined();
  });

  it('staging adapters are live, never mocks', () => {
    expect(staging.deps.adapters.descriptors().some((d) => d.kind === 'mock')).toBe(false);
    expect(staging.deps.adapters.demoStore).toBeNull();
  });
});
