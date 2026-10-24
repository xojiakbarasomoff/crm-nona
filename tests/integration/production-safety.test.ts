import { afterAll, describe, expect, it } from 'vitest';
import { assertProductionSafety } from '../../apps/api/src/core';
import { DEMO_PASSWORD } from '../../packages/database/src/seed';
import { makeCore } from './helpers';

const staging = makeCore({ env: { APP_MODE: 'staging', COOKIE_SECURE: 'true', META_GRAPH_VERSION: 'v-test', AMO_CHAT_CHANNEL_ID: 'test-channel', SCANNER: 'clamav', STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_ENDPOINT: 'http://127.0.0.1:1' } });
const demo = makeCore();
const simple = makeCore({ env: { DEMO_SIMPLE_LOGIN: 'true' } });

afterAll(async () => {
  await staging.close();
  await demo.close();
  await simple.close();
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

  it('staging refuses a local-disk file store (private object storage required)', () => {
    expect(() => makeCore({ env: { APP_MODE: 'staging', COOKIE_SECURE: 'true', META_GRAPH_VERSION: 'v-test', AMO_CHAT_CHANNEL_ID: 'c', SCANNER: 'clamav', STORAGE_DRIVER: 'local' } })).toThrow(/local-private/);
  });

  it('staging adapters are live, never mocks', () => {
    expect(staging.deps.adapters.descriptors().some((d) => d.kind === 'mock')).toBe(false);
    expect(staging.deps.adapters.demoStore).toBeNull();
  });
});

describe('DEMO_SIMPLE_LOGIN (short demo logins) is demo-only', () => {
  it('is refused outside demo mode', () => {
    expect(() => makeCore({ env: { APP_MODE: 'staging', COOKIE_SECURE: 'true', META_GRAPH_VERSION: 'v-test', AMO_CHAT_CHANNEL_ID: 'c', SCANNER: 'clamav', STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_ENDPOINT: 'http://127.0.0.1:1', DEMO_SIMPLE_LOGIN: 'true' } })).toThrow(/only allowed in demo mode/);
  });

  it('short names do not log in unless the flag is on', async () => {
    await expect(demo.auth.login({ email: 'user2', password: DEMO_PASSWORD, ip: '10.0.1.1', userAgent: null })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('with the flag, admin / user1 / user2 map to the seeded demo accounts; admin needs no TOTP', async () => {
    for (const [name, ip] of [['user1', '10.0.2.1'], ['user2', '10.0.2.2'], ['admin', '10.0.2.3']] as const) {
      const r = await simple.auth.login({ email: name, password: DEMO_PASSWORD, ip, userAgent: null });
      const info = await simple.auth.resolveSession(r.token);
      expect(info?.actor.email).toBe({ user1: 'rahbar@demo.local', user2: 'menejer.a@demo.local', admin: 'admin@demo.local' }[name]);
      expect(info?.mfaRequired).toBe(false);
    }
  });

  it('the flag does not weaken the default core: admin still needs TOTP', async () => {
    await expect(demo.auth.login({ email: 'admin@demo.local', password: DEMO_PASSWORD, ip: '10.0.3.1', userAgent: null })).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
});
