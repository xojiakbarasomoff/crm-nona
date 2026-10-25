import type { Role } from '@crm/database';
import type { CoreDeps, UserActor } from '../context';
import { AuthService } from './auth.service';

export interface AccountSpec {
  login: string;
  fullName: string;
  role: Role;
  password: string;
  email?: string;
}

const BACKUP = '_backup_cutover_20261026';

/**
 * Рабочие учётные записи и закрытие старых демо-аккаунтов (CLI `accounts:provision`).
 * Пароли здесь только в памяти: в БД пишется argon2-хеш. Перед каждым изменением существующих строк
 * их прежние значения сохраняются в таблицу `_backup_cutover_20261026` (восстановимая копия).
 */
export class AccountsService {
  private readonly auth: AuthService;
  constructor(private readonly d: CoreDeps) {
    this.auth = new AuthService(d);
  }

  private async companyId() {
    return (await this.d.prisma.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })).id;
  }

  private async ensureBackupTable() {
    await this.d.prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${BACKUP} (id bigserial PRIMARY KEY, taken_at timestamptz NOT NULL DEFAULT now(), kind text NOT NULL, entity_id text NOT NULL, old_value jsonb)`);
  }

  private async backup(kind: string, rows: Array<{ id: string } & Record<string, unknown>>) {
    for (const r of rows) await this.d.prisma.$executeRawUnsafe(`INSERT INTO ${BACKUP} (kind, entity_id, old_value) VALUES ($1, $2, $3::jsonb)`, kind, r.id, JSON.stringify(r));
  }

  /** Создаёт или обновляет аккаунты (идемпотентно) и назначает первого администратора дежурным ответственным. */
  async provision(accounts: AccountSpec[]) {
    if (!accounts.length) throw new Error('accounts[] required');
    const prisma = this.d.prisma;
    const companyId = await this.companyId();
    await this.ensureBackupTable();
    const out: Array<{ login: string; role: Role; id: string; created: boolean }> = [];
    for (const a of accounts) {
      const login = a.login.trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,40}$/.test(login) || !a.password || !['ADMIN', 'MANAGER', 'USER'].includes(a.role)) throw new Error(`invalid account spec for "${login}"`);
      const email = (a.email ?? `${login}@nonatravel.local`).toLowerCase();
      const passwordHash = await this.auth.hashPassword(a.password);
      const existing = await prisma.user.findFirst({ where: { OR: [{ login }, { email }] } });
      if (existing) await this.backup('user', [{ id: existing.id, login: existing.login, email: existing.email, role: existing.role, status: existing.status, fullName: existing.fullName, passwordHashSet: !!existing.passwordHash }]);
      const row = existing
        ? await prisma.user.update({ where: { id: existing.id }, data: { login, fullName: a.fullName, role: a.role, status: 'active', blockedAt: null, passwordHash, mfaEnabled: false, mfaSecretEnc: null, version: { increment: 1 } } })
        : await prisma.user.create({ data: { companyId, login, email, fullName: a.fullName, role: a.role, status: 'active', passwordHash } });
      await prisma.auditLog.create({ data: { companyId, actorType: 'system', entityType: 'user', entityId: row.id, action: existing ? 'account_updated' : 'account_created', newValue: { login, role: a.role }, correlationId: row.id } });
      out.push({ login, role: a.role, id: row.id, created: !existing });
    }
    const admin = out.find((o) => o.role === 'ADMIN');
    if (admin) {
      const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
      await this.backup('company_duty', [{ id: company.id, dutyUserId: company.dutyUserId }]);
      await prisma.company.update({ where: { id: companyId }, data: { dutyUserId: admin.id } });
    }
    return { accounts: out, dutyUserId: admin?.id ?? null };
  }

  /**
   * После проверки входа: блокирует старые `@demo.local`, отзывает их сессии, передаёт активные записи
   * первому реальному администратору и отключает записи старой интеграции. Историю и аудит не трогает.
   */
  async closeLegacy() {
    const prisma = this.d.prisma;
    const companyId = await this.companyId();
    await this.ensureBackupTable();
    const admins = await prisma.user.findMany({ where: { companyId, role: 'ADMIN', status: 'active', login: { not: null }, NOT: { email: { endsWith: '@demo.local' } } }, orderBy: { createdAt: 'asc' } });
    const successor = admins[0];
    if (!successor?.passwordHash) throw new Error('No active real administrator with a login: create accounts first');
    const actor: UserActor = { type: 'user', id: successor.id, companyId, role: 'ADMIN', email: successor.email, extraCapabilities: [] };
    const legacy = await prisma.user.findMany({ where: { companyId, email: { endsWith: '@demo.local' }, status: { not: 'blocked' } } });
    const closed: Array<{ email: string; moved: { leads: number; orders: number; reminders: number }; tasks: number; contacts: number }> = [];
    for (const u of legacy) {
      const [leads, orders, tasks, segments, reminders, contacts] = await Promise.all([
        prisma.lead.findMany({ where: { companyId, ownerId: u.id, stage: { notIn: ['WON', 'LOST'] }, deletedAt: null }, select: { id: true, ownerId: true } }),
        prisma.order.findMany({ where: { companyId, ownerId: u.id, fulfillmentState: { notIn: ['completed', 'cancelled'] } }, select: { id: true, ownerId: true } }),
        prisma.crmTask.findMany({ where: { companyId, responsibleUserId: u.id, state: { in: ['pending', 'open'] } }, select: { id: true, responsibleUserId: true } }),
        prisma.flightSegment.findMany({ where: { companyId, ownerId: u.id, active: true }, select: { id: true, ownerId: true } }),
        prisma.reminderOccurrence.findMany({ where: { companyId, assigneeId: u.id, state: { in: ['scheduled', 'due', 'snoozed', 'dispatching'] } }, select: { id: true, assigneeId: true } }),
        prisma.contact.findMany({ where: { companyId, ownerId: u.id }, select: { id: true, ownerId: true } }),
      ]);
      await this.backup('user', [{ id: u.id, email: u.email, role: u.role, status: u.status, blockedAt: u.blockedAt }]);
      await this.backup('lead_owner', leads);
      await this.backup('order_owner', orders);
      await this.backup('task_owner', tasks);
      await this.backup('segment_owner', segments);
      await this.backup('reminder_assignee', reminders);
      await this.backup('contact_owner', contacts);
      const moved = await this.auth.blockUser(actor, u.id, successor.id);
      await prisma.crmTask.updateMany({ where: { id: { in: tasks.map((t) => t.id) } }, data: { responsibleUserId: successor.id } });
      await prisma.contact.updateMany({ where: { id: { in: contacts.map((c) => c.id) } }, data: { ownerId: successor.id } });
      closed.push({ email: u.email, moved, tasks: tasks.length, contacts: contacts.length });
    }
    const ids = legacy.map((u) => u.id);
    await prisma.session.updateMany({ where: { userId: { in: ids }, revokedAt: null }, data: { revokedAt: this.d.clock.now() } });
    await prisma.managerPoolMember.updateMany({ where: { companyId, userId: { in: ids } }, data: { available: false } });
    const amo = await prisma.integrationConnection.findMany({ where: { companyId, provider: { in: ['AMOCRM_REST', 'AMOCRM_CHATS'] }, disconnectedAt: null }, select: { id: true, provider: true, health: true } });
    await this.backup('integration_connection', amo);
    await prisma.integrationConnection.updateMany({ where: { id: { in: amo.map((a) => a.id) } }, data: { health: 'disconnected', healthReason: 'amocrm_removed', disconnectedAt: this.d.clock.now(), credentialsEnc: null } });
    return { successor: successor.login, closed, legacyIntegrationsDisconnected: amo.length };
  }
}
