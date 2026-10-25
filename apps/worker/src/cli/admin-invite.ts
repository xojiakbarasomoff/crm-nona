/**
 * Bootstrap the first administrator in a real deployment (no demo users exist outside demo mode).
 *   npm run admin:invite -- --email=admin@company.uz --name="Ism Familiya"
 * Prints a one-time activation link (72 h). MFA enrollment is enforced at first login.
 */
import { randomBytes } from 'node:crypto';
import { createCore, loadConfig } from '@crm/api/core';
import { sha256 } from '../../../api/src/core/services/auth.service';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

async function main() {
  const email = arg('email')?.toLowerCase();
  const name = arg('name');
  if (!email || !name) throw new Error('Usage: --email=... --name=...');
  if (email.endsWith('@demo.local')) throw new Error('@demo.local addresses are reserved for demo mode');
  const core = createCore(loadConfig());
  try {
    const company = await core.deps.prisma.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    if (await core.deps.prisma.user.findUnique({ where: { email } })) throw new Error('User already exists');
    const token = randomBytes(32).toString('base64url');
    await core.deps.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { companyId: company.id, email, fullName: name, role: 'ADMIN', status: 'invited' } });
      await tx.userInvite.create({ data: { companyId: company.id, userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 72 * 3600_000), createdById: user.id } });
      await tx.auditLog.create({ data: { companyId: company.id, actorType: 'system', entityType: 'user', entityId: user.id, action: 'admin_bootstrap_invited', correlationId: user.id } });
    });
    console.log(`Activation link (one-time, 72 h): ${core.deps.config.appPublicUrl}/activate?token=${token}`);
  } finally {
    await core.close();
  }
}

main().catch((err) => {
  console.error('admin:invite failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
