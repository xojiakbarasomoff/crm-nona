import type { Prisma } from '@crm/database';
import { can } from '@crm/domain';
import { audit } from '../audit';
import type { CoreDeps, UserActor } from '../context';
import { forbidden, unprocessable } from '../errors';
import { assertFound, requireCap } from '../scope';

/**
 * Contacts, duplicates and integration diagnostics.
 */
export class AdminService {
  constructor(private readonly d: CoreDeps) {}

  /** A manager sees a contact only through a lead or order they own. */
  async getContact(actor: UserActor, id: string) {
    const contact = assertFound(await this.d.prisma.contact.findFirst({ where: { id, companyId: actor.companyId, deletedAt: null } }), 'Mijoz');
    const leadFilter: Prisma.LeadWhereInput = { companyId: actor.companyId, contactId: id, deletedAt: null, ...(can(actor.role, 'records.view_all') ? {} : { ownerId: actor.id }) };
    const leads = await this.d.prisma.lead.findMany({ where: leadFilter, orderBy: { createdAt: 'desc' } });
    if (!can(actor.role, 'records.view_all') && leads.length === 0) assertFound(null, 'Mijoz');
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
      conversations: conversations.map((c) => ({ ...c, amoChatAvailable: !!c.amoChatId, historyAvailableFrom: c.historyAvailableFrom })),
    };
  }

  async listDuplicates(actor: UserActor) {
    const rows = await this.d.prisma.duplicateCandidate.findMany({ where: { companyId: actor.companyId, state: 'open' }, orderBy: { createdAt: 'desc' }, take: 200 });
    if (can(actor.role, 'records.view_all')) return rows;
    const mine = new Set((await this.d.prisma.lead.findMany({ where: { companyId: actor.companyId, ownerId: actor.id }, select: { contactId: true } })).map((l) => l.contactId));
    return rows.filter((r) => r.contactIds.every((c) => mine.has(c)));
  }

  /** Managers may only flag; heads/admins resolve. Merge is not marked complete until amoCRM is consistent. */
  async resolveDuplicate(actor: UserActor, id: string, input: { action: 'dismiss' | 'mark_shared' | 'merge' | 'flag'; primaryContactId?: string; note?: string }) {
    if (input.action !== 'flag') requireCap(actor, 'duplicates.resolve');
    else requireCap(actor, 'duplicates.flag');
    return this.d.prisma.$transaction(async (tx) => {
      const cand = assertFound(await tx.duplicateCandidate.findFirst({ where: { id, companyId: actor.companyId } }), 'Nomzod');
      if (input.action === 'flag') {
        await tx.duplicateCandidate.update({ where: { id }, data: { flaggedById: actor.id } });
      } else if (input.action === 'dismiss') {
        await tx.duplicateCandidate.update({ where: { id }, data: { state: 'dismissed', resolvedById: actor.id, resolvedAt: this.d.clock.now(), resolution: { note: input.note ?? null } } });
      } else if (input.action === 'mark_shared') {
        const ident = cand.identifier as { type: string; scope: string; value: string };
        if (ident.type === 'instagram_scoped') throw unprocessable('INVALID', 'Instagram ID umumiy deb belgilanmaydi');
        await tx.contactIdentifier.updateMany({ where: { companyId: actor.companyId, type: ident.type, scope: ident.scope, value: ident.value }, data: { shared: true } });
        await tx.duplicateCandidate.update({ where: { id }, data: { state: 'resolved_shared', resolvedById: actor.id, resolvedAt: this.d.clock.now() } });
      } else {
        if (!input.primaryContactId || !cand.contactIds.includes(input.primaryContactId)) throw unprocessable('PRIMARY_REQUIRED', 'Asosiy kontaktni tanlang', { primaryContactId: 'required' });
        const others = cand.contactIds.filter((c) => c !== input.primaryContactId);
        const contacts = await tx.contact.findMany({ where: { id: { in: cand.contactIds }, companyId: actor.companyId } });
        const amoIds = contacts.map((c) => c.amoContactId).filter(Boolean);
        // Local move of leads/orders/conversations is deferred until amoCRM merge is confirmed.
        await tx.duplicateCandidate.update({
          where: { id },
          data: { state: amoIds.length > 1 ? 'merge_pending_amocrm' : 'resolved_merged', resolvedById: actor.id, resolvedAt: this.d.clock.now(), resolution: { primary: input.primaryContactId, merged: others, conflicts: contacts.map((c) => ({ id: c.id, fullName: c.fullName, phone: c.primaryPhone, email: c.primaryEmail })) } },
        });
        if (amoIds.length <= 1) {
          for (const o of others) {
            await tx.lead.updateMany({ where: { companyId: actor.companyId, contactId: o }, data: { contactId: input.primaryContactId } });
            await tx.order.updateMany({ where: { companyId: actor.companyId, contactId: o }, data: { contactId: input.primaryContactId } });
            await tx.conversation.updateMany({ where: { companyId: actor.companyId, contactId: o }, data: { contactId: input.primaryContactId } });
            await tx.inquiry.updateMany({ where: { companyId: actor.companyId, contactId: o }, data: { contactId: input.primaryContactId } });
            await tx.contactIdentifier.updateMany({ where: { companyId: actor.companyId, contactId: o, type: { not: 'instagram_scoped' } }, data: { contactId: input.primaryContactId } });
            await tx.contactIdentifier.updateMany({ where: { companyId: actor.companyId, contactId: o, type: 'instagram_scoped' }, data: { contactId: input.primaryContactId } });
            await tx.contact.update({ where: { id: o }, data: { mergedIntoId: input.primaryContactId, deletedAt: this.d.clock.now() } });
          }
        }
      }
      await audit(tx, actor, { entityType: 'duplicate', entityId: id, action: `duplicate_${input.action}`, newValue: input });
      return tx.duplicateCandidate.findUniqueOrThrow({ where: { id } });
    });
  }

  async integrationsHealth(actor: UserActor) {
    if (!can(actor.role, 'integrations.manage') && !can(actor.role, 'dashboard.company')) throw forbidden();
    const [connections, inbox, outbox, oldestInbox, oldestOutbox, heartbeats, dead, unknown] = await Promise.all([
      this.d.prisma.integrationConnection.findMany({
        where: { companyId: actor.companyId },
        select: { id: true, provider: true, mode: true, accountId: true, accountDomain: true, health: true, healthReason: true, lastWebhookAt: true, lastSyncAt: true, lastError: true, expiresAt: true, disconnectedAt: true },
      }),
      this.d.prisma.webhookInbox.groupBy({ by: ['state'], where: { OR: [{ companyId: actor.companyId }, { companyId: null }] }, _count: true }),
      this.d.prisma.outboxOperation.groupBy({ by: ['state'], where: { companyId: actor.companyId }, _count: true }),
      this.d.prisma.webhookInbox.findFirst({ where: { companyId: actor.companyId, state: { in: ['pending', 'failed'] } }, orderBy: { receivedAt: 'asc' }, select: { receivedAt: true } }),
      this.d.prisma.outboxOperation.findFirst({ where: { companyId: actor.companyId, state: { in: ['pending', 'failed'] } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      this.d.prisma.workerHeartbeat.findMany(),
      this.d.prisma.outboxOperation.findMany({ where: { companyId: actor.companyId, state: 'dead' }, orderBy: { updatedAt: 'desc' }, take: 50, select: { id: true, action: true, lastError: true, attempts: true, updatedAt: true } }),
      this.d.prisma.outboxOperation.findMany({ where: { companyId: actor.companyId, state: { in: ['unknown', 'paused'] } }, orderBy: { updatedAt: 'desc' }, take: 50, select: { id: true, action: true, state: true, lastError: true, updatedAt: true } }),
    ]);
    const now = this.d.clock.now().getTime();
    const metricKeys = ['webhook_count', 'signature_failures', 'inbox_retries', 'inbox_dead', 'outbox_retries', 'outbox_dead', 'provider_429', 'token_refresh_failures', 'sync_conflicts'];
    const values = await this.d.redis.mget(...metricKeys.map((k) => `metrics:${k}`)).catch(() => metricKeys.map(() => null));
    const overdue = await this.d.prisma.reminderOccurrence.count({ where: { companyId: actor.companyId, state: 'due', dispatchedAt: { lt: new Date(now - 15 * 60_000) } } });
    return {
      appMode: this.d.config.mode,
      directChannelMode: this.d.config.directChannelMode,
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
    };
  }
}
