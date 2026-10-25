 
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { DEFAULT_MILESTONE_RULES } from '@crm/domain';
import { createPrisma, encryptSecret, loadEncryptionKey, type PrismaClient } from './index';

/**
 * Synthetic seed (TZ §21: demo/test data only). Idempotent: running it twice changes nothing.
 * Refuses to run outside APP_MODE=demo unless SEED_ALLOW_NON_DEMO=1 (users/rules only, no fake data).
 */

export const DEMO_PASSWORD = 'Demo-parol-2026!';
/** Demo-only TOTP secret for the seeded administrator (documented in README). */
export const DEMO_ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
export const DEMO_COMPANY_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_IG_BUSINESS_ID = '17840000000000001';
export const DEMO_PAGE_ID = '100000000000001';

export const WORK_SCHEDULE = {
  timezone: 'Asia/Tashkent',
  days: Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [d, [{ start: '09:00', end: '19:00' }]])),
};

/** DEMO_SIMPLE_LOGIN: weak, publicly known password for the three aliased demo accounts (demo mode only). */
export const DEMO_SIMPLE_PASSWORD = '123123123';
export const DEMO_SIMPLE_ACCOUNTS = ['admin@demo.local', 'admin2@demo.local', 'menejer.a@demo.local'];

export async function seed(prisma: PrismaClient, opts: { demoData: boolean; key: Buffer; simpleLogin?: boolean }) {
  const company = await prisma.company.upsert({
    where: { id: DEMO_COMPANY_ID },
    update: {},
    create: {
      id: DEMO_COMPANY_ID,
      name: opts.demoData ? 'Demo Turizm (sun’iy)' : 'Kompaniya (sozlanmagan)',
      timezone: 'Asia/Tashkent',
      workSchedule: WORK_SCHEDULE,
      slaFirstResponseMinutes: 15,
      stickyOwner: true,
      phoneRule: { countryCode: '998', nationalLength: 9, confirmed: false },
      settings: {
        leadForms: {},
        // Proposed retention (TZ §21). Purge jobs run only after the company confirms it.
        retention: { confirmed: false, rawWebhookDays: 30, technicalLogDays: 90, messageContentMonths: 12 },
      },
    },
  });

  for (const r of DEFAULT_MILESTONE_RULES) {
    const exists = await prisma.reminderRule.findFirst({ where: { companyId: company.id, milestone: r.milestone } });
    if (!exists) await prisma.reminderRule.create({ data: { companyId: company.id, milestone: r.milestone, offsetSeconds: r.offsetSeconds, enabled: r.enabled, escalateAfterMinutes: r.escalateAfterMinutes, version: 1, current: true } });
  }
  // Demo users exist ONLY in demo mode. Real deployments bootstrap the first admin with
  // `npm run admin:invite` (one-time activation link, own password, MFA enrollment).
  if (!opts.demoData) return { company, ids: {} as Record<string, string> };

  const passwordHash = await hash(DEMO_PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const users = [
    { email: 'admin@demo.local', fullName: 'Admin (demo)', role: 'ADMIN' as const },
    { email: 'admin2@demo.local', fullName: 'Admin 2 (demo)', role: 'ADMIN' as const },
    { email: 'menejer.a@demo.local', fullName: 'Menejer A (demo)', role: 'MANAGER' as const },
    { email: 'menejer.b@demo.local', fullName: 'Menejer B (demo)', role: 'MANAGER' as const },
    { email: 'menejer.c@demo.local', fullName: 'Menejer C (demo)', role: 'MANAGER' as const },
    { email: 'user@demo.local', fullName: 'Foydalanuvchi (demo)', role: 'USER' as const },
  ];
  const ids: Record<string, string> = {};
  for (const u of users) {
    const row = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        companyId: company.id,
        email: u.email,
        fullName: u.fullName,
        role: u.role,
        status: 'active',
        passwordHash,
        ...(u.role === 'ADMIN' ? { mfaEnabled: true, mfaSecretEnc: encryptSecret(DEMO_ADMIN_TOTP_SECRET, opts.key) } : {}),
      },
    });
    ids[u.email] = row.id;
  }
  if (opts.simpleLogin) {
    const simpleHash = await hash(DEMO_SIMPLE_PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    await prisma.user.updateMany({ where: { email: { in: DEMO_SIMPLE_ACCOUNTS } }, data: { passwordHash: simpleHash } });
  }
  await prisma.company.update({ where: { id: company.id }, data: { dutyUserId: ids['admin2@demo.local'] } });

  const pool = await prisma.managerPool.findFirst({ where: { companyId: company.id, isDefault: true } });
  if (!pool) {
    const p = await prisma.managerPool.create({ data: { companyId: company.id, name: 'Asosiy navbat', isDefault: true } });
    const managers = users.filter((u) => u.role === 'MANAGER');
    for (const [i, m] of managers.entries()) {
      await prisma.managerPoolMember.create({ data: { companyId: company.id, poolId: p.id, userId: ids[m.email]!, position: i, schedule: WORK_SCHEDULE } });
    }
  }


  // Demo integration connections (mode=demo). Real connections are created via OAuth.
  const conns = [
    { provider: 'META_LEADS' as const, accountId: DEMO_PAGE_ID, accountDomain: null, settings: {} },
    { provider: 'META_DIRECT' as const, accountId: DEMO_IG_BUSINESS_ID, accountDomain: null, settings: {} },
  ];
  for (const c of conns) {
    await prisma.integrationConnection.upsert({
      where: { companyId_provider_accountId: { companyId: company.id, provider: c.provider, accountId: c.accountId } },
      update: {},
      create: { companyId: company.id, provider: c.provider, mode: 'demo', accountId: c.accountId, accountDomain: c.accountDomain, routeToken: `demo-${c.provider.toLowerCase()}-${randomBytes(8).toString('hex')}`, settings: c.settings },
    });
  }
  return { company, ids };
}

async function main() {
  const mode = process.env.APP_MODE ?? 'demo';
  if (mode !== 'demo' && process.env.SEED_ALLOW_NON_DEMO !== '1') {
    console.error('Seed refused: APP_MODE is not demo. Set SEED_ALLOW_NON_DEMO=1 to seed company/users/rules without demo data.');
    process.exit(1);
  }
  const prisma = createPrisma();
  try {
    const simpleLogin = mode === 'demo' && ['true', '1'].includes(process.env.DEMO_SIMPLE_LOGIN ?? '');
    await seed(prisma, { demoData: mode === 'demo', key: loadEncryptionKey(), simpleLogin });
    console.log(`Seed done (mode=${mode}). Demo users: admin@demo.local, admin2@demo.local, menejer.a|b|c@demo.local, user@demo.local — password "${DEMO_PASSWORD}" (DEMO ONLY).`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
