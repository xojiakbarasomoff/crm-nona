import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { decryptSecret, encryptSecret, type Role } from '@crm/database';
import { capabilitiesOf } from '@crm/domain';
import { hitCounter } from '@crm/integrations';
import { audit } from '../audit';
import type { CoreDeps, UserActor } from '../context';
import { AppError, conflict, forbidden, notFound, tooMany, unauthorized, unprocessable } from '../errors';
import { requireCap } from '../scope';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../totp';

/** Argon2id parameters (OWASP baseline: m=19 MiB, t=2, p=1). */
const ARGON = { algorithm: 2 as const, memoryCost: 19_456, timeCost: 2, parallelism: 1 };
const IDLE_MS = 12 * 3600_000;
const ABSOLUTE_MS = 7 * 24 * 3600_000;
const INVITE_MS = 72 * 3600_000;
const LOGIN_WINDOW_SEC = 15 * 60;
const LOGIN_MAX = 10;

export const DEMO_EMAIL_DOMAIN = '@demo.local';
/** Short demo logins (DEMO_SIMPLE_LOGIN=true, demo mode only) → seeded demo accounts. */
export const DEMO_LOGIN_ALIASES: Record<string, string> = { admin: 'admin@demo.local', user1: 'rahbar@demo.local', user2: 'menejer.a@demo.local' };
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

export interface SessionInfo {
  actor: UserActor;
  mfaVerified: boolean;
  mfaRequired: boolean;
  mfaEnrolled: boolean;
}

export class AuthService {
  constructor(private readonly d: CoreDeps) {}

  hashPassword(password: string) {
    return hash(password, ARGON);
  }

  validatePasswordPolicy(password: string) {
    if (password.length < 12) throw unprocessable('WEAK_PASSWORD', 'Parol kamida 12 belgidan iborat bo‘lishi kerak', { password: 'min_length_12' });
  }

  async login(input: { email: string; password: string; totp?: string | null; ip: string | null; userAgent: string | null }) {
    const identifier = input.email.trim().toLowerCase();
    const simple = this.d.config.demoSimpleLogin && this.d.config.mode === 'demo';
    const email = simple ? (DEMO_LOGIN_ALIASES[identifier] ?? identifier) : identifier;
    const attempts = await hitCounter(this.d.redis, `login:${email}:${input.ip ?? '-'}`, LOGIN_WINDOW_SEC);
    if (attempts > LOGIN_MAX) throw tooMany();

    // Demo accounts (@demo.local) never authenticate outside APP_MODE=demo.
    const demoAccountBlocked = this.d.config.mode !== 'demo' && email.endsWith(DEMO_EMAIL_DOMAIN);
    const user = demoAccountBlocked ? null : await this.d.prisma.user.findUnique({ where: { email } });
    // Constant-ish work even when the user does not exist.
    const ok = user?.passwordHash ? await verify(user.passwordHash, input.password).catch(() => false) : (await hash('dummy-password', ARGON), false);
    if (!user || !ok || user.status !== 'active') {
      if (user) {
        await audit(this.d.prisma, { type: 'system', id: null, companyId: user.companyId, name: 'auth' }, { entityType: 'user', entityId: user.id, action: 'login_failed', newValue: { ip: input.ip } });
      }
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email yoki parol noto‘g‘ri');
    }

    let mfaVerified = false;
    if (user.role === 'ADMIN' && user.mfaEnabled && !simple) {
      if (!input.totp) throw new AppError(401, 'MFA_REQUIRED', 'MFA kodi talab qilinadi');
      const secret = decryptSecret(user.mfaSecretEnc!, this.d.encryptionKey);
      if (!verifyTotp(secret, input.totp, this.d.clock.now().getTime())) throw new AppError(401, 'MFA_INVALID', 'MFA kodi noto‘g‘ri');
      mfaVerified = true;
    }

    const token = newToken();
    const now = this.d.clock.now();
    const session = await this.d.prisma.session.create({
      data: { userId: user.id, tokenHash: sha256(token), mfaVerified, ip: input.ip, userAgent: input.userAgent?.slice(0, 300) ?? null, expiresAt: new Date(now.getTime() + ABSOLUTE_MS) },
    });
    await this.d.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
    await this.d.redis.del(`login:${email}:${input.ip ?? '-'}`);
    await audit(this.d.prisma, { type: 'user', id: user.id, companyId: user.companyId, role: user.role, email: user.email }, { entityType: 'user', entityId: user.id, action: 'login', newValue: { sessionId: session.id, ip: input.ip } });
    return { token, csrfToken: newToken(), sessionId: session.id };
  }

  /** Resolves and refreshes a session. Returns null for invalid/expired/revoked sessions or blocked users. */
  async resolveSession(token: string | undefined): Promise<SessionInfo | null> {
    if (!token) return null;
    const now = this.d.clock.now();
    const session = await this.d.prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    if (now.getTime() - session.lastSeenAt.getTime() > IDLE_MS) return null;
    if (session.user.status !== 'active') return null;
    if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
      await this.d.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    }
    const u = session.user;
    return {
      actor: { type: 'user', id: u.id, companyId: u.companyId, role: u.role, email: u.email, sessionId: session.id },
      mfaVerified: session.mfaVerified,
      mfaRequired: u.role === 'ADMIN' && !(this.d.config.demoSimpleLogin && this.d.config.mode === 'demo'),
      mfaEnrolled: u.mfaEnabled,
    };
  }

  async logout(actor: UserActor) {
    if (!actor.sessionId) return;
    await this.d.prisma.session.update({ where: { id: actor.sessionId }, data: { revokedAt: this.d.clock.now() } });
    await audit(this.d.prisma, actor, { entityType: 'user', entityId: actor.id, action: 'logout' });
  }

  async me(actor: UserActor, info: SessionInfo) {
    const user = await this.d.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      amoUserId: user.amoUserId,
      capabilities: capabilitiesOf(user.role),
      mfa: { required: info.mfaRequired, enrolled: info.mfaEnrolled, verified: info.mfaVerified },
      appMode: this.d.config.mode,
    };
  }

  // ---- MFA enrollment (admin) ----

  async startMfaEnrollment(actor: UserActor) {
    const user = await this.d.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (user.mfaEnabled) throw conflict('MFA_ALREADY_ENABLED', 'MFA allaqachon yoqilgan');
    const secret = generateTotpSecret();
    await this.d.redis.set(`mfa_enroll:${user.id}`, encryptSecret(secret, this.d.encryptionKey), 'EX', 600);
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  async confirmMfaEnrollment(actor: UserActor, code: string) {
    const enc = await this.d.redis.get(`mfa_enroll:${actor.id}`);
    if (!enc) throw unprocessable('MFA_ENROLLMENT_EXPIRED', 'MFA sozlash muddati tugadi, qaytadan boshlang');
    const secret = decryptSecret(enc, this.d.encryptionKey);
    if (!verifyTotp(secret, code, this.d.clock.now().getTime())) throw new AppError(401, 'MFA_INVALID', 'MFA kodi noto‘g‘ri');
    await this.d.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: actor.id }, data: { mfaEnabled: true, mfaSecretEnc: encryptSecret(secret, this.d.encryptionKey), version: { increment: 1 } } });
      if (actor.sessionId) await tx.session.update({ where: { id: actor.sessionId }, data: { mfaVerified: true } });
      await audit(tx, actor, { entityType: 'user', entityId: actor.id, action: 'mfa_enabled' });
    });
    await this.d.redis.del(`mfa_enroll:${actor.id}`);
  }

  // ---- User management (admin) ----

  async inviteUser(actor: UserActor, input: { email: string; fullName: string; role: Role; amoUserId: string | null }) {
    requireCap(actor, 'users.manage');
    const email = input.email.trim().toLowerCase();
    const token = newToken();
    const result = await this.d.prisma.$transaction(async (tx) => {
      const exists = await tx.user.findUnique({ where: { email } });
      if (exists) throw conflict('EMAIL_EXISTS', 'Bu email bilan foydalanuvchi mavjud');
      const user = await tx.user.create({ data: { companyId: actor.companyId, email, fullName: input.fullName, role: input.role, amoUserId: input.amoUserId, status: 'invited' } });
      await tx.userInvite.create({
        data: { companyId: actor.companyId, userId: user.id, tokenHash: sha256(token), expiresAt: new Date(this.d.clock.now().getTime() + INVITE_MS), createdById: actor.id },
      });
      await audit(tx, actor, { entityType: 'user', entityId: user.id, action: 'invited', newValue: { email, role: input.role, amoUserId: input.amoUserId } });
      return user;
    });
    return { userId: result.id, activationUrl: `${this.d.config.appPublicUrl}/activate?token=${token}` };
  }

  async activate(token: string, password: string) {
    this.validatePasswordPolicy(password);
    const invite = await this.d.prisma.userInvite.findUnique({ where: { tokenHash: sha256(token) } });
    const now = this.d.clock.now();
    if (!invite || invite.usedAt || invite.expiresAt <= now) throw unprocessable('INVITE_INVALID', 'Aktivlashtirish havolasi yaroqsiz yoki muddati o‘tgan');
    const passwordHash = await this.hashPassword(password);
    await this.d.prisma.$transaction(async (tx) => {
      const used = await tx.userInvite.updateMany({ where: { id: invite.id, usedAt: null }, data: { usedAt: now } });
      if (used.count !== 1) throw unprocessable('INVITE_INVALID', 'Aktivlashtirish havolasi allaqachon ishlatilgan');
      const user = await tx.user.update({ where: { id: invite.userId }, data: { passwordHash, status: 'active', version: { increment: 1 } } });
      await audit(tx, { type: 'user', id: user.id, companyId: user.companyId, role: user.role, email: user.email }, { entityType: 'user', entityId: user.id, action: 'activated' });
    });
  }

  async changeRole(actor: UserActor, userId: string, role: Role) {
    requireCap(actor, 'users.manage');
    await this.d.prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({ where: { id: userId, companyId: actor.companyId } });
      if (!user) throw notFound('Foydalanuvchi');
      if (user.id === actor.id) throw forbidden('O‘z rolingizni o‘zgartira olmaysiz');
      await tx.user.update({ where: { id: user.id }, data: { role, version: { increment: 1 } } });
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: this.d.clock.now() } });
      await audit(tx, actor, { entityType: 'user', entityId: user.id, action: 'role_changed', oldValue: { role: user.role }, newValue: { role } });
    });
  }

  /**
   * Blocks a user immediately: all sessions revoked; open leads, orders, segments and reminders are
   * moved to the chosen successor with audit (TZ §6.2).
   */
  async blockUser(actor: UserActor, userId: string, successorId: string | null) {
    requireCap(actor, 'users.manage');
    const now = this.d.clock.now();
    return this.d.prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({ where: { id: userId, companyId: actor.companyId } });
      if (!user) throw notFound('Foydalanuvchi');
      if (user.id === actor.id) throw forbidden('O‘zingizni bloklay olmaysiz');
      if (successorId) {
        const successor = await tx.user.findFirst({ where: { id: successorId, companyId: actor.companyId, status: 'active' } });
        if (!successor) throw unprocessable('SUCCESSOR_INVALID', 'Yangi mas’ul faol foydalanuvchi bo‘lishi kerak');
      }
      await tx.user.update({ where: { id: user.id }, data: { status: 'blocked', blockedAt: now, version: { increment: 1 } } });
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
      await tx.managerPoolMember.updateMany({ where: { companyId: actor.companyId, userId: user.id }, data: { available: false } });
      let moved = { leads: 0, orders: 0, reminders: 0 };
      if (successorId) {
        const openLeads = await tx.lead.findMany({ where: { companyId: actor.companyId, ownerId: user.id, stage: { notIn: ['WON', 'LOST'] }, deletedAt: null }, select: { id: true } });
        moved = {
          leads: openLeads.length,
          orders: (await tx.order.updateMany({ where: { companyId: actor.companyId, ownerId: user.id, fulfillmentState: { notIn: ['completed', 'cancelled'] } }, data: { ownerId: successorId } })).count,
          reminders: (await tx.reminderOccurrence.updateMany({ where: { companyId: actor.companyId, assigneeId: user.id, state: { in: ['scheduled', 'due', 'snoozed', 'dispatching'] } }, data: { assigneeId: successorId } })).count,
        };
        await tx.flightSegment.updateMany({ where: { companyId: actor.companyId, ownerId: user.id, active: true }, data: { ownerId: successorId } });
        // Lead ownership is owned by amoCRM: the reassignment goes through the normal path.
        await tx.outboxOperation.createMany({
          data: openLeads.map((l) => ({
            companyId: actor.companyId,
            operationKey: `lead.reassign:${l.id}:block:${user.id}`,
            target: 'amocrm',
            action: 'lead.reassign',
            payload: { leadId: l.id, toUserId: successorId, reason: 'user_blocked' },
            correlationId: `block:${user.id}`,
          })),
          skipDuplicates: true,
        });
      }
      await audit(tx, actor, { entityType: 'user', entityId: user.id, action: 'blocked', newValue: { successorId, moved } });
      return moved;
    });
  }

  async listUsers(actor: UserActor) {
    requireCap(actor, 'users.manage');
    return this.d.prisma.user.findMany({
      where: { companyId: actor.companyId },
      select: { id: true, email: true, fullName: true, role: true, status: true, amoUserId: true, mfaEnabled: true, lastLoginAt: true },
      orderBy: { fullName: 'asc' },
    });
  }

  unauthorizedError() {
    return unauthorized();
  }
}
