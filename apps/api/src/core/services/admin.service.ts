import type { Prisma } from '@crm/database';
import { can } from '@crm/domain';
import type { CoreDeps, UserActor } from '../context';
import { forbidden } from '../errors';
import { assertFound } from '../scope';

/**
 * Контакты и диагностика интеграций.
 */
/** Цели исходящей очереди старой интеграции с amoCRM: записи хранятся, но в диагностике не показываются. */
const LEGACY_TARGETS = ['amocrm', 'amocrm_chats'];

export class AdminService {
  constructor(private readonly d: CoreDeps) {}

  /** A manager sees a contact only through a lead or order they own. */
  async getContact(actor: UserActor, id: string) {
    const contact = assertFound(await this.d.prisma.contact.findFirst({ where: { id, companyId: actor.companyId, deletedAt: null } }), 'Клиент');
    const leadFilter: Prisma.LeadWhereInput = { companyId: actor.companyId, contactId: id, deletedAt: null, ...(can(actor.role, 'records.view_all') ? {} : { ownerId: actor.id }) };
    const leads = await this.d.prisma.lead.findMany({ where: leadFilter, orderBy: { createdAt: 'desc' } });
    if (!can(actor.role, 'records.view_all') && leads.length === 0) assertFound(null, 'Клиент');
    const leadIds = leads.map((l) => l.id);
    const [identifiers, inquiries, orders, conversations] = await Promise.all([
      this.d.prisma.contactIdentifier.findMany({ where: { companyId: actor.companyId, contactId: id, active: true }, select: { id: true, type: true, value: true, scope: true, shared: true, verified: true, displayUsername: true } }),
      this.d.prisma.inquiry.findMany({ where: { companyId: actor.companyId, contactId: id, ...(can(actor.role, 'records.view_all') ? {} : { leadId: { in: leadIds } }) }, orderBy: { receivedAt: 'desc' }, take: 100 }),
      this.d.prisma.order.findMany({ where: { companyId: actor.companyId, contactId: id, ...(can(actor.role, 'records.view_all') ? {} : { ownerId: actor.id }) }, select: { id: true, orderNo: true, fulfillmentState: true, paymentState: true } }),
      this.d.prisma.conversation.findMany({
        where: { companyId: actor.companyId, contactId: id, ...(can(actor.role, 'records.view_all') ? {} : { leadId: { in: leadIds } }) },
        include: { messages: { orderBy: { createdAt: 'asc' }, take: 200, select: { id: true, direction: true, type: true, content: true, state: true, actorType: true, createdAt: true, providerAt: true } } },
      }),
    ]);
    return {
      contact,
      identifiers,
      leads,
      inquiries,
      orders,
      conversations: conversations.map((c) => ({ ...c, historyAvailableFrom: c.historyAvailableFrom })),
    };
  }

  async integrationsHealth(actor: UserActor) {
    if (!can(actor.role, 'integrations.manage') && !can(actor.role, 'dashboard.company')) throw forbidden();
    const [connections, inbox, outbox, oldestInbox, oldestOutbox, heartbeats, dead, unknown] = await Promise.all([
      this.d.prisma.integrationConnection.findMany({
        where: { companyId: actor.companyId, provider: { in: ['META_DIRECT', 'META_LEADS'] } },
        select: { id: true, provider: true, mode: true, accountId: true, accountDomain: true, health: true, healthReason: true, lastWebhookAt: true, lastSyncAt: true, lastError: true, expiresAt: true, disconnectedAt: true },
      }),
      this.d.prisma.webhookInbox.groupBy({ by: ['state'], where: { OR: [{ companyId: actor.companyId }, { companyId: null }] }, _count: true }),
      this.d.prisma.outboxOperation.groupBy({ by: ['state'], where: { companyId: actor.companyId, target: { notIn: LEGACY_TARGETS } }, _count: true }),
      this.d.prisma.webhookInbox.findFirst({ where: { companyId: actor.companyId, state: { in: ['pending', 'failed'] } }, orderBy: { receivedAt: 'asc' }, select: { receivedAt: true } }),
      this.d.prisma.outboxOperation.findFirst({ where: { companyId: actor.companyId, target: { notIn: LEGACY_TARGETS }, state: { in: ['pending', 'failed'] } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      this.d.prisma.workerHeartbeat.findMany(),
      this.d.prisma.outboxOperation.findMany({ where: { companyId: actor.companyId, target: { notIn: LEGACY_TARGETS }, state: 'dead' }, orderBy: { updatedAt: 'desc' }, take: 50, select: { id: true, action: true, lastError: true, attempts: true, updatedAt: true } }),
      this.d.prisma.outboxOperation.findMany({ where: { companyId: actor.companyId, target: { notIn: LEGACY_TARGETS }, state: { in: ['unknown', 'paused'] } }, orderBy: { updatedAt: 'desc' }, take: 50, select: { id: true, action: true, state: true, lastError: true, updatedAt: true } }),
    ]);
    const now = this.d.clock.now().getTime();
    const metricKeys = ['webhook_count', 'signature_failures', 'inbox_retries', 'inbox_dead', 'outbox_retries', 'outbox_dead', 'provider_429', 'token_refresh_failures'];
    const values = await this.d.redis.mget(...metricKeys.map((k) => `metrics:${k}`)).catch(() => metricKeys.map(() => null));
    const checkpoints = await this.d.prisma.syncCheckpoint.findMany({ where: { companyId: actor.companyId, stream: { startsWith: 'leadforms:' } }, select: { stream: true, lastRunAt: true, lastResult: true, cursor: true }, orderBy: { stream: 'asc' } });
    const company = await this.d.prisma.company.findUniqueOrThrow({ where: { id: actor.companyId } });
    const retention = ((company.settings ?? {}) as { retention?: { confirmed?: boolean } }).retention ?? null;
    const slaBreachesOpen = await this.d.prisma.lead.count({ where: { companyId: actor.companyId, slaBreachedAt: { not: null }, firstHumanActionAt: null, deletedAt: null, stage: { notIn: ['WON', 'LOST'] } } });
    const attachmentsPendingScan = await this.d.prisma.attachment.count({ where: { companyId: actor.companyId, scanState: 'pending', deletedAt: null } });
    const overdue = await this.d.prisma.reminderOccurrence.count({ where: { companyId: actor.companyId, state: 'due', dispatchedAt: { lt: new Date(now - 15 * 60_000) } } });
    return {
      appMode: this.d.config.mode,
      adapters: this.d.adapters.descriptors(),
      connections,
      inbox: Object.fromEntries(inbox.map((r) => [r.state, r._count])),
      outbox: Object.fromEntries(outbox.map((r) => [r.state, r._count])),
      oldestPendingInboxAgeSec: oldestInbox ? Math.round((now - oldestInbox.receivedAt.getTime()) / 1000) : 0,
      oldestPendingOutboxAgeSec: oldestOutbox ? Math.round((now - oldestOutbox.createdAt.getTime()) / 1000) : 0,
      heartbeats: heartbeats.map((h) => ({ name: h.name, lastBeatAt: h.lastBeatAt, ageSec: Math.round((now - h.lastBeatAt.getTime()) / 1000), info: h.info })),
      deadLetters: dead,
      needsOperator: unknown,
      metrics: Object.fromEntries(metricKeys.map((k, i) => [k, Number(values[i] ?? 0)])),
      overdueReminders: overdue,
      checkpoints,
      retention: retention ? { ...retention, status: retention.confirmed ? 'active' : 'not_confirmed_purge_disabled' } : { status: 'not_configured' },
      slaBreachesOpen,
      attachmentsPendingScan,
      scanner: this.d.adapters.scanner.descriptor,
      storage: this.d.adapters.storage.descriptor,
    };
  }
}
