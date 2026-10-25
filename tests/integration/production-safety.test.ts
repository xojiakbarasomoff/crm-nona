import { afterAll, describe, expect, it } from 'vitest';
import { assertProductionSafety } from '../../apps/api/src/core';
import { DEMO_PASSWORD } from '../../packages/database/src/seed';
import { makeCore } from './helpers';

const staging = makeCore({ env: { APP_MODE: 'staging', COOKIE_SECURE: 'true', META_GRAPH_VERSION: 'v-test', SCANNER: 'clamav', STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_ENDPOINT: 'http://127.0.0.1:1' } });
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
    expect(() => makeCore({ env: { APP_MODE: 'staging', COOKIE_SECURE: 'true', META_GRAPH_VERSION: 'v-test', SCANNER: 'clamav', STORAGE_DRIVER: 'local' } })).toThrow(/local-private/);
  });

  it('staging adapters are live, never mocks', () => {
    expect(staging.deps.adapters.descriptors().some((d) => d.kind === 'mock')).toBe(false);
    expect(staging.deps.adapters.demoStore).toBeNull();
  });
});

describe('DEMO_SIMPLE_LOGIN (short demo logins) is demo-only', () => {
  it('is refused outside demo mode', () => {
    expect(() => makeCore({ env: { APP_MODE: 'staging', COOKIE_SECURE: 'true', META_GRAPH_VERSION: 'v-test', SCANNER: 'clamav', STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_ENDPOINT: 'http://127.0.0.1:1', DEMO_SIMPLE_LOGIN: 'true' } })).toThrow(/only allowed in demo mode/);
  });

  it('old demo aliases (admin / user1 / user2) no longer exist, with or without the flag', async () => {
    for (const core of [demo, simple]) {
      for (const [name, ip] of [['user2', '10.0.1.1'], ['user1', '10.0.1.2'], ['admin', '10.0.1.3']] as const) {
        await expect(core.auth.login({ email: name, password: DEMO_PASSWORD, ip, userAgent: null })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
      }
    }
  });

  it('real login-name accounts sign in without an email, with hashed passwords; wrong password and blocked users do not', async () => {
    const company = await demo.deps.prisma.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const tag = Date.now().toString(36);
    const mk = async (login: string, role: 'ADMIN' | 'MANAGER' | 'USER', password: string) =>
      demo.deps.prisma.user.create({ data: { companyId: company.id, login, email: `${login}@nonatravel.local`, fullName: login, role, status: 'active', passwordHash: await demo.auth.hashPassword(password) } });
    const admin = await mk(`qa_admin_${tag}`, 'ADMIN', 'nonatravel123');
    const mgr = await mk(`qa_mgr_${tag}`, 'MANAGER', '12345');
    const usr = await mk(`qa_user_${tag}`, 'USER', '12345');
    expect(admin.passwordHash).toMatch(/^\$argon2id\$/);
    expect(admin.passwordHash).not.toContain('nonatravel123');
    // MFA is not enrolled for these accounts, so no code is asked at login
    for (const [u, pw, ip] of [[admin, 'nonatravel123', '10.0.4.1'], [mgr, '12345', '10.0.4.2'], [usr, '12345', '10.0.4.3']] as const) {
      const r = await demo.auth.login({ email: u.login!.toUpperCase(), password: pw, ip, userAgent: null });
      const info = await demo.auth.resolveSession(r.token);
      expect(info?.actor).toMatchObject({ id: u.id, role: u.role });
    }
    await expect(demo.auth.login({ email: mgr.login!, password: 'wrong', ip: '10.0.4.4', userAgent: null })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await demo.deps.prisma.user.update({ where: { id: usr.id }, data: { status: 'blocked' } });
    await expect(demo.auth.login({ email: usr.login!, password: '12345', ip: '10.0.4.5', userAgent: null })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('the flag does not weaken the default core: admin still needs TOTP', async () => {
    await expect(demo.auth.login({ email: 'admin@demo.local', password: DEMO_PASSWORD, ip: '10.0.3.1', userAgent: null })).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
});
