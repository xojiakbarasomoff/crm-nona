import type { IntegrationConnection, OutboxOperation, Prisma, WebhookInbox } from '@crm/database';
import { decryptSecret } from '@crm/database';
import { backoffDelayMs, decideRetry, formatMoney, singleCurrencySelling, type ErrorClass } from '@crm/domain';
import { ProviderError, type AmoCrmSignal, type AmoRestClient, type ChatsOutgoingReply, type MetaEvent } from '@crm/integrations';
import { audit } from '../audit';
import { integrationActor, systemActor, type CoreDeps } from '../context';
import { headRecipients, notify, publishEvent } from '../events';
import { ConnectionPausedError, IntakeService, connectionToken } from './intake.service';
import { LeadsService } from './leads.service';
import { orderFinance } from './orders.service';

type HandlerResult = { kind: 'done'; result?: Record<string, unknown> } | { kind: 'retry_later'; delayMs: number; reason: string };

class DependencyPending extends Error {}
const MAX_INBOX_ATTEMPTS = 8;

/**
 * Inbox and outbox executors (TZ §19). Both claim rows with a lease so a crashed worker's rows are
 * picked up again; outbox handlers reconcile before re-creating anything (AC29).
 */
export class ProcessingService {
  private readonly intake: IntakeService;
  private readonly leads: LeadsService;
  constructor(private readonly d: CoreDeps) {
    this.intake = new IntakeService(d);
    this.leads = new LeadsService(d);
  }

  // ======================= Inbox =======================

  async claimInboxBatch(limit = 50): Promise<string[]> {
    const rows = await this.d.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM webhook_inbox
      WHERE state IN ('pending', 'failed') AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
      ORDER BY received_at LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  async processInbox(id: string): Promise<string> {
    const claimed = await this.d.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE webhook_inbox SET state = 'processing', lease_until = now() + interval '5 minutes', attempts = attempts + 1
      WHERE id = ${id}::uuid AND state IN ('pending', 'failed') AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
      RETURNING id`;
    if (!claimed.length) return 'not_claimed';
    const row = await this.d.prisma.webhookInbox.findUniqueOrThrow({ where: { id } });
    try {
      const payload = JSON.parse(decryptSecret(row.payloadEnc, this.d.encryptionKey));
      const outcome = await this.handleInbox(row, payload);
      await this.d.prisma.webhookInbox.update({ where: { id }, data: { state: outcome === 'ignored' ? 'ignored' : 'done', processedAt: this.d.clock.now(), leaseUntil: null, lastError: null } });
      await this.d.redis.incr('metrics:inbox_processed');
      return outcome;
    } catch (err) {
      if (err instanceof ConnectionPausedError) {
        await this.d.prisma.webhookInbox.update({ where: { id }, data: { state: 'pending', attempts: { decrement: 1 }, nextAttemptAt: new Date(this.d.clock.now().getTime() + 60_000), leaseUntil: null, lastError: 'connection_paused' } });
        return 'paused';
      }
      const attempts = row.attempts;
      const dead = attempts >= MAX_INBOX_ATTEMPTS || (err instanceof ProviderError && err.errorClass === 'validation');
      const delay = err instanceof ProviderError && err.retryAfterMs ? err.retryAfterMs : Math.max(1000, backoffDelayMs(attempts));
      await this.d.prisma.webhookInbox.update({
        where: { id },
        data: { state: dead ? 'dead' : 'failed', nextAttemptAt: new Date(this.d.clock.now().getTime() + delay), leaseUntil: null, lastError: (err as Error).message.slice(0, 500) },
      });
      await this.d.redis.incr(dead ? 'metrics:inbox_dead' : 'metrics:inbox_retries');
      this.d.logger.warn({ inboxId: id, provider: row.provider, err: (err as Error).message }, 'inbox processing failed');
      return dead ? 'dead' : 'failed';
    }
  }

  private async handleInbox(row: WebhookInbox, payload: unknown): Promise<string> {
    const receivedAt = row.receivedAt;
    if (row.provider === 'meta') {
      const evt = payload as MetaEvent;
      switch (evt.kind) {
        case 'leadgen':
          return this.intake.processLeadgen({ ...evt, createdTime: evt.createdTime ? new Date(evt.createdTime) : null }, receivedAt, row.correlationId);
        case 'ig_message':
          return this.intake.processIgMessage({ ...evt, timestamp: new Date(evt.timestamp) }, receivedAt, row.correlationId);
        case 'ig_read':
          return this.intake.processIgRead({ ...evt, timestamp: new Date(evt.timestamp) });
        default:
          return 'ignored';
      }
    }
    if (row.provider === 'amocrm_crm') return this.applyAmoSignal(row.connectionKey, payload as AmoCrmSignal);
    if (row.provider === 'amocrm_chat') {
      const reply = payload as ChatsOutgoingReply;
      return this.intake.processChatReply({ ...reply, timestamp: new Date(reply.timestamp) }, row.connectionKey);
    }
    return 'ignored';
  }

  /** CRM webhooks are only signals: the lead is re-read from amoCRM and applied monotonically. */
  async applyAmoSignal(routeToken: string, signal: AmoCrmSignal): Promise<string> {
    const conn = await this.d.prisma.integrationConnection.findUnique({ where: { routeToken } });
    if (!conn || conn.provider !== 'AMOCRM_REST') return 'ignored';
    if (signal.accountId && signal.accountId !== conn.accountId) return 'ignored';
    if (conn.disconnectedAt || conn.health === 'paused' || conn.health === 'disconnected') throw new ConnectionPausedError(conn.id);
    if (signal.entity !== 'leads') return 'ignored';
    const client = this.d.adapters.amoRest(conn);
    const snap = await client.getLead(signal.id);
    if (!snap) {
      if (signal.action === 'delete') {
        const lead = await this.d.prisma.lead.findFirst({ where: { companyId: conn.companyId, amoLeadId: signal.id } });
        if (lead && !lead.deletedAt) {
          await this.d.prisma.$transaction((tx) => this.leads.applyRemoteSnapshot(tx, conn.companyId, { id: signal.id, name: lead.name, pipelineId: '', statusId: '', responsibleUserId: null, price: null, updatedAt: this.d.clock.now(), createdAt: null, closedAt: null, contactIds: [], customFields: {}, deleted: true }, { origin: 'amocrm' }));
        }
      }
      return 'processed';
    }
    const res = await this.d.prisma.$transaction((tx) => this.leads.applyRemoteSnapshot(tx, conn.companyId, snap, { origin: 'amocrm' }));
    await this.d.prisma.integrationConnection.update({ where: { id: conn.id }, data: { lastSyncAt: this.d.clock.now() } });
    return res.applied ? 'processed' : res.reason;
  }

  // ======================= Outbox =======================

  async claimOutboxBatch(limit = 50): Promise<string[]> {
    const rows = await this.d.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM outbox_operations
      WHERE state IN ('pending', 'failed') AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
      ORDER BY next_attempt_at LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  /** Rows left in `processing` by a crashed worker go back to pending; handlers reconcile first. */
  async recoverExpiredLeases(): Promise<number> {
    const a = await this.d.prisma.$executeRaw`UPDATE outbox_operations SET state = 'pending', lease_until = NULL, last_error = coalesce(last_error, 'lease_expired') WHERE state = 'processing' AND lease_until < now()`;
    const b = await this.d.prisma.$executeRaw`UPDATE webhook_inbox SET state = 'pending', lease_until = NULL WHERE state = 'processing' AND lease_until < now()`;
    return a + b;
  }

  async executeOutbox(id: string): Promise<string> {
    const claimed = await this.d.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE outbox_operations SET state = 'processing', lease_until = now() + interval '5 minutes', attempts = attempts + 1,
             first_attempt_at = coalesce(first_attempt_at, now()), updated_at = now()
      WHERE id = ${id}::uuid AND state IN ('pending', 'failed') AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
      RETURNING id`;
    if (!claimed.length) return 'not_claimed';
    const op = await this.d.prisma.outboxOperation.findUniqueOrThrow({ where: { id } });
    try {
      const conn = await this.connectionFor(op);
      if (conn === 'paused') {
        await this.finish(op, { state: 'paused', lastError: 'connection_paused', attempts: { decrement: 1 } });
        return 'paused';
      }
      const r = await this.runHandler(op, conn);
      if (r.kind === 'retry_later') {
        await this.finish(op, { state: 'pending', nextAttemptAt: new Date(this.d.clock.now().getTime() + r.delayMs), lastError: r.reason, attempts: { decrement: 1 } });
        return 'deferred';
      }
      await this.finish(op, { state: 'done', result: (r.result ?? {}) as Prisma.InputJsonValue, lastError: null, errorClass: null });
      return 'done';
    } catch (err) {
      return this.handleOutboxError(op, err);
    }
  }

  private async finish(op: OutboxOperation, data: Prisma.OutboxOperationUpdateInput) {
    await this.d.prisma.outboxOperation.update({ where: { id: op.id }, data: { ...data, leaseUntil: null } });
  }

  private async handleOutboxError(op: OutboxOperation, err: unknown): Promise<string> {
    const cls: ErrorClass = err instanceof ProviderError ? err.errorClass : err instanceof DependencyPending ? 'transient' : ((err as { errorClass?: ErrorClass }).errorClass ?? 'transient');
    const retryAfter = err instanceof ProviderError ? err.retryAfterMs : null;
    const decision = decideRetry(cls, op.attempts, { retryAfterMs: retryAfter, firstAttemptAt: op.firstAttemptAt ?? undefined, now: this.d.clock.now() });
    const message = (err as Error).message.slice(0, 500);
    if (cls === 'rate_limited') await this.d.redis.incr('metrics:provider_429');
    this.d.logger.warn({ operationId: op.id, action: op.action, errorClass: cls, decision: decision.action, err: message }, 'outbox operation failed');
    switch (decision.action) {
      case 'retry':
        await this.finish(op, { state: 'failed', nextAttemptAt: new Date(this.d.clock.now().getTime() + (decision.delayMs ?? 1000)), lastError: message, errorClass: cls });
        await this.d.redis.incr('metrics:outbox_retries');
        return 'retry';
      case 'unknown':
        await this.finish(op, { state: 'unknown', lastError: message, errorClass: cls });
        await this.markUnknown(op);
        return 'unknown';
      case 'pause_connection':
      case 'refresh_token':
        await this.finish(op, { state: 'paused', lastError: message, errorClass: cls });
        if (op.connectionId) await this.d.prisma.integrationConnection.update({ where: { id: op.connectionId }, data: { health: 'paused', healthReason: cls, lastError: message } });
        await this.signalAdmins(op.companyId, 'integration_paused', `Integratsiya to‘xtatildi (${cls}): ${op.action}`, `paused:${op.id}`);
        return 'paused';
      case 'dead_letter':
      default:
        await this.finish(op, { state: 'dead', lastError: message, errorClass: cls });
        await this.d.redis.incr('metrics:outbox_dead');
        await this.signalAdmins(op.companyId, 'outbox_dead', `Operatsiya bajarilmadi va to‘xtatildi: ${op.action}`, `dead:${op.id}`);
        return 'dead';
    }
  }

  /** Unknown outcome is surfaced to operators; never blindly retried (TZ §19.2). */
  private async markUnknown(op: OutboxOperation) {
    const payload = op.payload as Record<string, string>;
    if (op.action === 'meta.send' && payload.messageId) {
      await this.d.prisma.message.update({ where: { id: payload.messageId }, data: { state: 'unknown', error: 'outcome_unknown' } });
    }
    if (op.action === 'lead.create' && payload.leadId) {
      await this.d.prisma.lead.update({ where: { id: payload.leadId }, data: { syncState: 'unknown' } });
    }
    await this.signalAdmins(op.companyId, 'outbox_unknown', `Natijasi noma’lum operatsiya: ${op.action}. Tekshirib, xavfsiz replay qiling.`, `unknown:${op.id}`);
  }

  private async signalAdmins(companyId: string, kind: string, title: string, key: string) {
    await this.d.prisma.$transaction(async (tx) => {
      const admins = await tx.user.findMany({ where: { companyId, role: 'ADMIN', status: 'active' }, select: { id: true } });
      for (const a of admins) await notify(tx, { companyId, userId: a.id, kind, dedupeKey: `${key}:${a.id}`, title, link: '/integrations' });
    });
  }

  private async connectionFor(op: OutboxOperation): Promise<IntegrationConnection | null | 'paused'> {
    const provider = op.target === 'amocrm' ? 'AMOCRM_REST' : op.target === 'amocrm_chats' ? 'AMOCRM_CHATS' : op.target === 'meta' ? null : null;
    if (!provider) return null;
    const conn = await this.d.prisma.integrationConnection.findFirst({ where: { companyId: op.companyId, provider }, orderBy: { createdAt: 'asc' } });
    if (!conn || conn.disconnectedAt || conn.health === 'paused' || conn.health === 'disconnected') return 'paused';
    if (op.connectionId !== conn.id) await this.d.prisma.outboxOperation.update({ where: { id: op.id }, data: { connectionId: conn.id } });
    return conn;
  }

  private amo(conn: IntegrationConnection | null): AmoRestClient {
    if (!conn) throw new Error('amoCRM connection required');
    return this.d.adapters.amoRest(conn);
  }

  private async runHandler(op: OutboxOperation, conn: IntegrationConnection | null): Promise<HandlerResult> {
    const p = op.payload as Record<string, unknown>;
    switch (op.action) {
      case 'lead.create':
        return this.handleLeadCreate(op, conn!, p.leadId as string);
      case 'lead.stage':
        return this.handleLeadStage(op, conn!, p.leadId as string, p.stage as string);
      case 'lead.reassign':
        return this.handleLeadReassign(op, conn!, p.leadId as string, p.toUserId as string);
      case 'task.create':
        return this.handleTaskCreate(op, conn!, p.crmTaskId as string);
      case 'task.complete':
        return this.handleTaskComplete(conn!, p.crmTaskId as string, (p.result as string) ?? 'Bajarildi');
      case 'task.reassign':
        return this.handleTaskReassign(conn!, p.crmTaskId as string, p.toUserId as string);
      case 'order.summary':
        return this.handleOrderSummary(op, conn!, p.orderId as string);
      case 'chat.import':
        return this.handleChatImport(conn, p.messageId as string);
      case 'chat.status':
        return this.handleChatStatus(conn, p.messageId as string, p.status as 'delivered' | 'read' | 'failed', p.error as string | undefined);
      case 'meta.enrich':
        return this.handleEnrich(p.inquiryId as string, p.adId as string, p.connectionId as string);
      case 'meta.send':
        return this.handleMetaSend(op, p.messageId as string, (p.tag as 'HUMAN_AGENT' | null) ?? null);
      case 'amo.import': {
        const { AmoSyncService } = await import('./amo-sync.service');
        return { kind: 'done', result: await new AmoSyncService(this.d).importInitial(op.companyId) };
      }
      case 'meta.backfill': {
        const { LeadAdsBackfillService } = await import('./lead-ads-backfill.service');
        const since = typeof p.since === 'string' ? new Date(p.since) : undefined;
        return { kind: 'done', result: (await new LeadAdsBackfillService(this.d).run(op.companyId, { since })) as unknown as Record<string, unknown> };
      }
      default:
        throw new ProviderError(`Unknown outbox action ${op.action}`, 'validation', null);
    }
  }

  // ---------- amoCRM ----------

  private async bindCreatedLead(companyId: string, leadId: string, contactLocalId: string, amo: { leadId: string; contactId: string | null }, client: AmoRestClient, connectionId: string) {
    const snap = await client.getLead(amo.leadId);
    await this.d.prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: leadId }, data: { amoLeadId: amo.leadId, syncState: 'synced', sourceUpdatedAt: snap?.updatedAt ?? null } });
      if (amo.contactId) await tx.contact.updateMany({ where: { id: contactLocalId, amoContactId: null }, data: { amoContactId: amo.contactId, syncState: 'synced' } });
      await tx.integrationMapping.createMany({
        data: [
          { companyId, connectionId, entityType: 'lead', localId: leadId, externalId: amo.leadId, lastSyncedAt: this.d.clock.now() },
          ...(amo.contactId ? [{ companyId, connectionId, entityType: 'contact', localId: contactLocalId, externalId: amo.contactId, lastSyncedAt: this.d.clock.now() }] : []),
        ],
        skipDuplicates: true,
      });
      const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
      await this.leads.createCrmTask(tx, {
        companyId,
        key: `${leadId}:first_contact:created`,
        entityId: leadId,
        kind: 'first_contact',
        text: `Birinchi aloqa: ${lead.name}`,
        responsibleUserId: lead.ownerId,
        dueAt: lead.firstResponseDueAt ?? new Date(this.d.clock.now().getTime() + 15 * 60_000),
      });
      await audit(tx, integrationActor(companyId, 'amocrm'), { entityType: 'lead', entityId: leadId, action: 'amo_linked', newValue: { amoLeadId: amo.leadId, amoContactId: amo.contactId } });
    });
    await publishEvent(this.d.redis, { companyId, entityType: 'lead', entityId: leadId, kind: 'synced' });
  }

  private async handleLeadCreate(op: OutboxOperation, conn: IntegrationConnection, leadId: string): Promise<HandlerResult> {
    const lead = await this.d.prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    if (lead.amoLeadId) return { kind: 'done', result: { alreadyLinked: lead.amoLeadId } };
    const client = this.amo(conn);
    const contact = await this.d.prisma.contact.findUniqueOrThrow({ where: { id: lead.contactId } });
    // Reconcile first on every retry: a previous attempt may have created the lead (AC29).
    if (op.attempts > 1 || op.lastError) {
      const found = await client.findLeadByOperationId(lead.id);
      if (found) {
        await this.bindCreatedLead(op.companyId, lead.id, contact.id, found, client, conn.id);
        return { kind: 'done', result: { reconciled: true, amoLeadId: found.leadId } };
      }
    }
    const status = await this.leads.statusForStage(this.d.prisma, op.companyId, lead.stage);
    if (!status) throw new ProviderError('Pipeline status mapping missing: run amo-config', 'validation', null);
    const owner = lead.ownerId ? await this.d.prisma.user.findUnique({ where: { id: lead.ownerId }, select: { amoUserId: true } }) : null;
    const opField = await this.d.prisma.integrationMapping.findFirst({ where: { companyId: op.companyId, entityType: 'custom_field', localId: 'external_operation_id' } });
    const identifiers = await this.d.prisma.contactIdentifier.findMany({ where: { contactId: contact.id, active: true } });
    try {
      const created = await client.createLeadWithContact({
        name: lead.name,
        pipelineId: status.pipelineId,
        statusId: status.statusId,
        responsibleUserId: owner?.amoUserId ?? null,
        operationId: lead.id,
        operationFieldId: opField?.externalId ?? null,
        customFields: await this.sourceFields(op.companyId, lead),
        contact: {
          existingId: contact.amoContactId,
          name: contact.fullName ?? identifiers.find((i) => i.displayUsername)?.displayUsername ?? 'Instagram mijoz',
          phone: contact.primaryPhone,
          email: contact.primaryEmail,
        },
      });
      await this.bindCreatedLead(op.companyId, lead.id, contact.id, created, client, conn.id);
      return { kind: 'done', result: { amoLeadId: created.leadId } };
    } catch (err) {
      if (err instanceof ProviderError && err.errorClass === 'unknown_outcome') {
        const found = await client.findLeadByOperationId(lead.id).catch(() => null);
        if (found) {
          await this.bindCreatedLead(op.companyId, lead.id, contact.id, found, client, conn.id);
          return { kind: 'done', result: { reconciled: true, amoLeadId: found.leadId } };
        }
      }
      throw err;
    }
  }

  private async sourceFields(companyId: string, lead: { firstSource: string; firstInquiryId: string | null; id: string }) {
    const maps = await this.d.prisma.integrationMapping.findMany({ where: { companyId, entityType: 'custom_field' } });
    const field = (k: string) => maps.find((m) => m.localId === k)?.externalId;
    const inquiry = lead.firstInquiryId ? await this.d.prisma.inquiry.findUnique({ where: { id: lead.firstInquiryId } }) : null;
    const attribution = (inquiry?.attribution ?? {}) as Record<string, string | null>;
    const out: Array<{ fieldId: string; value: string }> = [];
    const push = (k: string, v: string | null | undefined) => {
      const id = field(k);
      if (id && v) out.push({ fieldId: id, value: v });
    };
    push('first_source', lead.firstSource);
    push('source_created_at', inquiry?.sourceCreatedAt?.toISOString());
    push('form_id', attribution.formId);
    push('campaign_ref', attribution.campaignId);
    push('ad_ref', attribution.adId);
    push('travel_lead_url', `${this.d.config.appPublicUrl}/leads/${lead.id}`);
    return out;
  }

  private async requireAmoLead(leadId: string) {
    const lead = await this.d.prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    if (!lead.amoLeadId) throw new DependencyPending('amoCRM lead not created yet');
    return lead;
  }

  private async confirmFromAmo(op: OutboxOperation, client: AmoRestClient, amoLeadId: string) {
    const snap = await client.getLead(amoLeadId);
    if (snap) await this.d.prisma.$transaction((tx) => this.leads.applyRemoteSnapshot(tx, op.companyId, snap, { origin: 'local_confirmed', operationKey: op.operationKey }));
  }

  private async handleLeadStage(op: OutboxOperation, conn: IntegrationConnection, leadId: string, stage: string): Promise<HandlerResult> {
    let lead;
    try {
      lead = await this.requireAmoLead(leadId);
    } catch (e) {
      if (e instanceof DependencyPending) return { kind: 'retry_later', delayMs: 5_000, reason: 'waiting_for_amo_lead' };
      throw e;
    }
    const client = this.amo(conn);
    const status = await this.leads.statusForStage(this.d.prisma, op.companyId, stage as never);
    if (!status) throw new ProviderError(`No amoCRM status mapped for ${stage}`, 'validation', null);
    // Read before write: detect a conflicting manual change made in amoCRM meanwhile (TZ §5.2).
    const current = await client.getLead(lead.amoLeadId!);
    if (current && lead.sourceUpdatedAt && current.updatedAt > lead.sourceUpdatedAt) {
      const remoteStage = await this.leads.stageForStatus(this.d.prisma, op.companyId, current.pipelineId, current.statusId);
      if (remoteStage && remoteStage !== lead.stage && remoteStage !== stage) {
        await this.d.prisma.$transaction(async (tx) => {
          await this.leads.applyRemoteSnapshot(tx, op.companyId, current, { origin: 'amocrm' });
          await tx.lead.update({ where: { id: lead.id }, data: { pendingChange: null as unknown as Prisma.InputJsonValue, syncState: 'conflict' } });
          await this.leads.createCrmTask(tx, { companyId: op.companyId, key: `${lead.id}:sync_conflict:${op.id}`, entityId: lead.id, kind: 'sync_conflict', text: `amoCRM’da bosqich qo‘lda o‘zgartirilgan (${remoteStage}); web’dagi «${stage}» so‘rovi qo‘llanmadi. Tekshiring.`, responsibleUserId: lead.ownerId, dueAt: new Date(this.d.clock.now().getTime() + 3600_000) });
        });
        await this.d.redis.incr('metrics:sync_conflicts');
        return { kind: 'done', result: { conflict: true, remoteStage } };
      }
    }
    await client.updateLead(lead.amoLeadId!, { pipelineId: status.pipelineId, statusId: status.statusId });
    await this.confirmFromAmo(op, client, lead.amoLeadId!);
    return { kind: 'done' };
  }

  private async handleLeadReassign(op: OutboxOperation, conn: IntegrationConnection, leadId: string, toUserId: string): Promise<HandlerResult> {
    let lead;
    try {
      lead = await this.requireAmoLead(leadId);
    } catch (e) {
      if (e instanceof DependencyPending) return { kind: 'retry_later', delayMs: 5_000, reason: 'waiting_for_amo_lead' };
      throw e;
    }
    const user = await this.d.prisma.user.findUniqueOrThrow({ where: { id: toUserId } });
    if (!user.amoUserId) throw new ProviderError('Target user has no amo_user_id mapping', 'validation', null);
    const client = this.amo(conn);
    await client.updateLead(lead.amoLeadId!, { responsibleUserId: user.amoUserId });
    await this.confirmFromAmo(op, client, lead.amoLeadId!);
    return { kind: 'done' };
  }

  private async amoEntityForTask(task: { entityType: string; entityId: string }): Promise<string | null> {
    if (task.entityType === 'lead') return (await this.d.prisma.lead.findUnique({ where: { id: task.entityId } }))?.amoLeadId ?? null;
    if (task.entityType === 'occurrence') {
      const occ = await this.d.prisma.reminderOccurrence.findUnique({ where: { id: task.entityId } });
      const order = occ?.orderId ? await this.d.prisma.order.findUnique({ where: { id: occ.orderId } }) : null;
      return order ? ((await this.d.prisma.lead.findUnique({ where: { id: order.leadId } }))?.amoLeadId ?? null) : null;
    }
    return null;
  }

  private async handleTaskCreate(op: OutboxOperation, conn: IntegrationConnection, crmTaskId: string): Promise<HandlerResult> {
    const task = await this.d.prisma.crmTask.findUniqueOrThrow({ where: { id: crmTaskId } });
    if (task.amoTaskId || task.state === 'cancelled' || task.state === 'completed') return { kind: 'done', result: { skipped: task.state } };
    const amoLeadId = await this.amoEntityForTask(task);
    if (!amoLeadId) return { kind: 'retry_later', delayMs: 10_000, reason: 'waiting_for_amo_lead' };
    const client = this.amo(conn);
    if (op.attempts > 1 || op.lastError) {
      const found = await client.findTaskByOperationKey('leads', amoLeadId, task.automationKey);
      if (found) {
        await this.d.prisma.crmTask.update({ where: { id: task.id }, data: { amoTaskId: found.taskId, state: 'open' } });
        return { kind: 'done', result: { reconciled: true } };
      }
    }
    const responsible = task.responsibleUserId ? await this.d.prisma.user.findUnique({ where: { id: task.responsibleUserId }, select: { amoUserId: true } }) : null;
    try {
      const { taskId } = await client.createTask({ entityType: 'leads', entityId: amoLeadId, text: task.text, completeTill: task.dueAt, responsibleUserId: responsible?.amoUserId ?? null, operationKey: task.automationKey });
      await this.d.prisma.crmTask.update({ where: { id: task.id }, data: { amoTaskId: taskId, state: 'open' } });
      if (task.entityType === 'occurrence') await this.d.prisma.notificationDelivery.updateMany({ where: { occurrenceId: task.entityId, channel: 'amocrm_task' }, data: { state: 'sent', externalTaskId: taskId, attempts: { increment: 1 } } });
      return { kind: 'done', result: { amoTaskId: taskId } };
    } catch (err) {
      if (err instanceof ProviderError && err.errorClass === 'unknown_outcome') {
        const found = await client.findTaskByOperationKey('leads', amoLeadId, task.automationKey).catch(() => null);
        if (found) {
          await this.d.prisma.crmTask.update({ where: { id: task.id }, data: { amoTaskId: found.taskId, state: 'open' } });
          return { kind: 'done', result: { reconciled: true } };
        }
      }
      throw err;
    }
  }

  private async handleTaskComplete(conn: IntegrationConnection, crmTaskId: string, result: string): Promise<HandlerResult> {
    const task = await this.d.prisma.crmTask.findUniqueOrThrow({ where: { id: crmTaskId } });
    if (!task.amoTaskId) return { kind: 'done', result: { skipped: 'never_created' } };
    await this.amo(conn).completeTask(task.amoTaskId, result);
    return { kind: 'done' };
  }

  private async handleTaskReassign(conn: IntegrationConnection, crmTaskId: string, toUserId: string): Promise<HandlerResult> {
    const task = await this.d.prisma.crmTask.findUniqueOrThrow({ where: { id: crmTaskId } });
    const user = await this.d.prisma.user.findUniqueOrThrow({ where: { id: toUserId } });
    if (!task.amoTaskId || !user.amoUserId) return { kind: 'done', result: { skipped: true } };
    await this.amo(conn).updateTaskResponsible(task.amoTaskId, user.amoUserId);
    return { kind: 'done' };
  }

  /** Short summary for the amoCRM card; failure never loses the local order (TZ §5.1). */
  private async handleOrderSummary(op: OutboxOperation, conn: IntegrationConnection, orderId: string): Promise<HandlerResult> {
    const order = await this.d.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const lead = await this.d.prisma.lead.findUniqueOrThrow({ where: { id: order.leadId } });
    if (!lead.amoLeadId) return { kind: 'retry_later', delayMs: 10_000, reason: 'waiting_for_amo_lead' };
    const maps = await this.d.prisma.integrationMapping.findMany({ where: { companyId: op.companyId, entityType: 'custom_field' } });
    const field = (k: string) => maps.find((m) => m.localId === k)?.externalId;
    const next = await this.d.prisma.flightSegment.findFirst({ where: { orderId, active: true, departureAtUtc: { gte: this.d.clock.now() } }, orderBy: { departureAtUtc: 'asc' } });
    // amoCRM'ga faqat SOTUV jami (yagona valyutada) yuboriladi; tannarx va foyda tashqi tizimga chiqmaydi.
    const eff = singleCurrencySelling(orderFinance(order, await this.d.prisma.orderService.findMany({ where: { orderId, removedAt: null } })));
    const values: Array<[string, string | null]> = [
      ['travel_order_id', order.orderNo],
      ['travel_order_url', `${this.d.config.appPublicUrl}/orders/${order.id}`],
      ['local_amount', eff ? `${formatMoney({ amountMinor: eff.amountMinor, currency: eff.currency })} ${eff.currency}` : order.agreedAmountMinor !== null && order.currency ? `${formatMoney({ amountMinor: order.agreedAmountMinor, currency: order.currency })} ${order.currency}` : null],
      ['next_departure_at', next?.departureAtUtc?.toISOString() ?? null],
      ['next_flight_no', next ? `${next.marketingCarrier} ${next.flightNumber}` : null],
      ['next_check_state', next?.checkState ?? null],
      ['next_reminder_at', next?.nextReminderAt?.toISOString() ?? null],
    ];
    const customFields = values.filter(([k, v]) => field(k) && v).map(([k, v]) => ({ fieldId: field(k)!, value: v! }));
    const company = await this.d.prisma.company.findUniqueOrThrow({ where: { id: op.companyId } });
    const priceCurrency = ((company.settings ?? {}) as { amoPriceCurrency?: string }).amoPriceCurrency;
    const priceMinor = eff ? (eff.currency === priceCurrency ? eff.amountMinor : null) : priceCurrency && order.currency === priceCurrency ? order.agreedAmountMinor : null;
    const price = priceCurrency && priceMinor !== null ? Number(priceMinor / 100n) : undefined;
    if (!customFields.length && price === undefined) return { kind: 'done', result: { skipped: 'no_mapped_fields' } };
    await this.amo(conn).updateLead(lead.amoLeadId, { customFields, ...(price !== undefined ? { price } : {}) });
    await this.d.prisma.order.update({ where: { id: orderId }, data: { amoSummaryState: 'synced' } });
    return { kind: 'done' };
  }

  // ---------- Chats / Meta ----------

  private async handleChatImport(conn: IntegrationConnection | null, messageId: string): Promise<HandlerResult> {
    if (!this.d.adapters.amoChats || !conn) return { kind: 'done', result: { skipped: 'native_connector' } };
    const msg = await this.d.prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    if (msg.amoMessageId) return { kind: 'done' };
    const conv = await this.d.prisma.conversation.findUniqueOrThrow({ where: { id: msg.conversationId } });
    const scopeId = ((conn.settings ?? {}) as { scopeId?: string }).scopeId;
    if (!scopeId) throw new ProviderError('Chats scope_id missing (G08)', 'validation', null);
    const r = await this.d.adapters.amoChats.importInbound(scopeId, {
      scopeId,
      conversationId: conv.id,
      msgId: msg.providerMessageId ?? msg.id,
      senderId: conv.scopedPeerId,
      senderName: conv.peerUsername,
      text: msg.content,
      attachments: [],
      timestamp: msg.providerAt ?? msg.createdAt,
    });
    await this.d.prisma.message.update({ where: { id: msg.id }, data: { amoMessageId: r.amoMessageId } });
    if (!conv.amoChatId) await this.d.prisma.conversation.update({ where: { id: conv.id }, data: { amoChatId: conv.id } });
    return { kind: 'done', result: { amoMessageId: r.amoMessageId } };
  }

  private async handleChatStatus(conn: IntegrationConnection | null, messageId: string, status: 'delivered' | 'read' | 'failed', error?: string): Promise<HandlerResult> {
    if (!this.d.adapters.amoChats || !conn) return { kind: 'done', result: { skipped: true } };
    const msg = await this.d.prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    const scopeId = ((conn.settings ?? {}) as { scopeId?: string }).scopeId;
    if (!scopeId || !msg.amoMessageId) return { kind: 'done', result: { skipped: true } };
    await this.d.adapters.amoChats.setDeliveryStatus(scopeId, msg.amoMessageId, status, error);
    return { kind: 'done' };
  }

  /** Enrichment is separate from lead creation; its failure is visible but never blocks (AC09). */
  private async handleEnrich(inquiryId: string, adId: string, connectionId: string): Promise<HandlerResult> {
    const conn = await this.d.prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
    try {
      const names = await this.d.adapters.metaLeads.fetchAdNames(adId, connectionToken(conn, this.d.encryptionKey));
      const inquiry = await this.d.prisma.inquiry.findUniqueOrThrow({ where: { id: inquiryId } });
      await this.d.prisma.inquiry.update({ where: { id: inquiryId }, data: { attribution: { ...(inquiry.attribution as object), ...names }, enrichmentState: 'done', enrichmentError: null } });
      return { kind: 'done' };
    } catch (err) {
      await this.d.prisma.inquiry.update({ where: { id: inquiryId }, data: { enrichmentState: 'failed', enrichmentError: (err as Error).message.slice(0, 300) } });
      throw err;
    }
  }

  private async handleMetaSend(op: OutboxOperation, messageId: string, tag: 'HUMAN_AGENT' | null): Promise<HandlerResult> {
    const msg = await this.d.prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    if (['accepted', 'delivered', 'read'].includes(msg.state)) return { kind: 'done', result: { alreadySent: true } };
    if (msg.state === 'unknown' || (op.attempts > 1 && msg.state === 'sending')) {
      // No safe automatic way to ask Meta whether it was sent: the operator decides (TZ §9.3).
      throw new ProviderError('Previous send attempt outcome unknown', 'unknown_outcome', null);
    }
    const conv = await this.d.prisma.conversation.findUniqueOrThrow({ where: { id: msg.conversationId } });
    const conn = await this.d.prisma.integrationConnection.findUniqueOrThrow({ where: { id: conv.connectionId } });
    if (conn.disconnectedAt || conn.health !== 'ok') throw Object.assign(new Error('Direct connection paused'), { errorClass: 'forbidden' as ErrorClass });
    await this.d.prisma.message.update({ where: { id: msg.id }, data: { state: 'sending' } });
    try {
      const r = await this.d.adapters.metaDirect.sendText({ businessAccountId: conv.businessAccountId, recipientScopedId: conv.scopedPeerId, text: msg.content ?? '', tag, accessToken: connectionToken(conn, this.d.encryptionKey) });
      const now = this.d.clock.now();
      await this.d.prisma.$transaction(async (tx) => {
        await tx.message.update({ where: { id: msg.id }, data: { state: 'accepted', providerMessageId: r.messageId, error: null } });
        await tx.conversation.update({ where: { id: conv.id }, data: { lastHumanReplyAt: now, ...(conv.firstHumanReplyAt ? {} : { firstHumanReplyAt: now }) } });
        if (conv.leadId) await tx.lead.updateMany({ where: { id: conv.leadId, firstHumanActionAt: null }, data: { firstHumanActionAt: now } });
      });
      return { kind: 'done', result: { providerMessageId: r.messageId } };
    } catch (err) {
      if (err instanceof ProviderError && err.errorClass !== 'unknown_outcome' && err.errorClass !== 'transient' && err.errorClass !== 'rate_limited') {
        await this.d.prisma.message.update({ where: { id: msg.id }, data: { state: 'failed', error: err.message.slice(0, 300) } });
        await this.d.prisma.$transaction(async (tx) => {
          const { enqueueOutbox } = await import('../queue');
          await enqueueOutbox(tx, { companyId: op.companyId, operationKey: `chat.status:${msg.id}:failed`, target: 'amocrm_chats', action: 'chat.status', payload: { messageId: msg.id, status: 'failed', error: 'Instagram xabarni qabul qilmadi' } });
        });
      } else if (err instanceof ProviderError && err.errorClass !== 'unknown_outcome') {
        await this.d.prisma.message.update({ where: { id: msg.id }, data: { state: 'queued' } });
      }
      throw err;
    }
  }

  /** Operator replay: same business keys; unknown operations are reconciled first by handlers. */
  async replay(companyId: string, operationId: string, actorUserId: string) {
    const op = await this.d.prisma.outboxOperation.findFirst({ where: { id: operationId, companyId } });
    if (!op) return null;
    if (!['dead', 'unknown', 'paused', 'failed'].includes(op.state)) return op;
    if (op.action === 'meta.send' && op.state === 'unknown') {
      const p = op.payload as { messageId: string };
      await this.d.prisma.message.update({ where: { id: p.messageId }, data: { state: 'queued', error: null } });
    }
    const updated = await this.d.prisma.outboxOperation.update({ where: { id: op.id }, data: { state: 'pending', nextAttemptAt: this.d.clock.now(), leaseUntil: null, lastError: op.lastError ? `replayed after: ${op.lastError}` : 'replayed' } });
    await audit(this.d.prisma, { type: 'user', id: actorUserId, companyId, role: 'ADMIN', email: '' }, { entityType: 'outbox_operation', entityId: op.id, action: 'replayed', oldValue: { state: op.state } });
    return updated;
  }

  async heads(companyId: string) {
    return headRecipients(this.d.prisma, companyId);
  }

  systemActor(companyId: string) {
    return systemActor(companyId, 'worker');
  }
}
