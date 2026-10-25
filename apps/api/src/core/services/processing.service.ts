import type { IntegrationConnection, OutboxOperation, Prisma, WebhookInbox } from '@crm/database';
import { decryptSecret } from '@crm/database';
import { backoffDelayMs, decideRetry, type ErrorClass } from '@crm/domain';
import { ProviderError, type MetaEvent } from '@crm/integrations';
import { audit } from '../audit';
import { systemActor, type CoreDeps } from '../context';
import { headRecipients, notify } from '../events';
import { ConnectionPausedError, IntakeService, connectionToken } from './intake.service';
import { markLiveVerified, SENDABLE_DEGRADED_REASONS } from './live-verification';

type HandlerResult = { kind: 'done'; result?: Record<string, unknown> } | { kind: 'retry_later'; delayMs: number; reason: string };

const MAX_INBOX_ATTEMPTS = 8;

/** Действия исходящей очереди, которые раньше отправлялись в amoCRM. Интеграция удалена: записи не удаляются, а закрываются без действия. */
const LEGACY_AMO_ACTIONS = new Set(['lead.create', 'lead.stage', 'lead.reassign', 'task.create', 'task.complete', 'task.reassign', 'order.summary', 'chat.import', 'chat.status', 'amo.import']);

/**
 * Inbox and outbox executors (TZ §19). Both claim rows with a lease so a crashed worker's rows are
 * picked up again; outbox handlers reconcile before re-creating anything (AC29).
 */
export class ProcessingService {
  private readonly intake: IntakeService;
  constructor(private readonly d: CoreDeps) {
    this.intake = new IntakeService(d);
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
    // Старые события amoCRM (если остались в очереди) закрываются без обработки.
    return 'ignored';
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
    const cls: ErrorClass = err instanceof ProviderError ? err.errorClass : ((err as { errorClass?: ErrorClass }).errorClass ?? 'transient');
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
        await this.signalAdmins(op.companyId, 'integration_paused', `Интеграция приостановлена (${cls}): ${op.action}`, `paused:${op.id}`);
        return 'paused';
      case 'dead_letter':
      default:
        await this.finish(op, { state: 'dead', lastError: message, errorClass: cls });
        await this.d.redis.incr('metrics:outbox_dead');
        await this.signalAdmins(op.companyId, 'outbox_dead', `Операция не выполнена и остановлена: ${op.action}`, `dead:${op.id}`);
        return 'dead';
    }
  }

  /** Unknown outcome is surfaced to operators; never blindly retried (TZ §19.2). */
  private async markUnknown(op: OutboxOperation) {
    const payload = op.payload as Record<string, string>;
    if (op.action === 'meta.send' && payload.messageId) {
      await this.d.prisma.message.update({ where: { id: payload.messageId }, data: { state: 'unknown', error: 'outcome_unknown' } });
    }
    await this.signalAdmins(op.companyId, 'outbox_unknown', `Результат операции неизвестен: ${op.action}. Проверьте и безопасно повторите.`, `unknown:${op.id}`);
  }

  private async signalAdmins(companyId: string, kind: string, title: string, key: string) {
    await this.d.prisma.$transaction(async (tx) => {
      const admins = await tx.user.findMany({ where: { companyId, role: 'ADMIN', status: 'active' }, select: { id: true } });
      for (const a of admins) await notify(tx, { companyId, userId: a.id, kind, dedupeKey: `${key}:${a.id}`, title, link: '/integrations' });
    });
  }

  private async connectionFor(op: OutboxOperation): Promise<IntegrationConnection | null | 'paused'> {
    // Instagram-операции сами выбирают соединение (по беседе / обращению); общей проверки подключения нет.
    void op;
    return null;
  }

  private async runHandler(op: OutboxOperation, _conn: IntegrationConnection | null): Promise<HandlerResult> {
    const p = op.payload as Record<string, unknown>;
    if (LEGACY_AMO_ACTIONS.has(op.action)) return { kind: 'done', result: { skipped: 'amocrm_removed' } };
    switch (op.action) {
      case 'meta.enrich':
        return this.handleEnrich(p.inquiryId as string, p.adId as string, p.connectionId as string);
      case 'meta.send':
        return this.handleMetaSend(op, p.messageId as string, (p.tag as 'HUMAN_AGENT' | null) ?? null);
      case 'meta.backfill': {
        const { LeadAdsBackfillService } = await import('./lead-ads-backfill.service');
        const since = typeof p.since === 'string' ? new Date(p.since) : undefined;
        return { kind: 'done', result: (await new LeadAdsBackfillService(this.d).run(op.companyId, { since })) as unknown as Record<string, unknown> };
      }
      default:
        throw new ProviderError(`Unknown outbox action ${op.action}`, 'validation', null);
    }
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
    const sendable = conn.health === 'ok' || (conn.health === 'degraded' && !!conn.healthReason && SENDABLE_DEGRADED_REASONS.includes(conn.healthReason));
    if (conn.disconnectedAt || !sendable) throw Object.assign(new Error('Direct connection paused'), { errorClass: 'forbidden' as ErrorClass });
    await this.d.prisma.message.update({ where: { id: msg.id }, data: { state: 'sending' } });
    try {
      // Haqiqiy (live) ulanish — haqiqiy Instagram mijozi; demo ulanish — demo adapter. Aralashtirilmaydi.
      const direct = conn.mode === 'live' ? this.d.adapters.metaDirectLive : this.d.adapters.metaDirect;
      if (!direct) throw Object.assign(new Error('META_GRAPH_VERSION is not configured: live Instagram client unavailable'), { errorClass: 'forbidden' as ErrorClass });
      const r = await direct.sendText({ businessAccountId: conv.businessAccountId, recipientScopedId: conv.scopedPeerId, text: msg.content ?? '', tag, accessToken: connectionToken(conn, this.d.encryptionKey) });
      const now = this.d.clock.now();
      await this.d.prisma.$transaction(async (tx) => {
        await tx.message.update({ where: { id: msg.id }, data: { state: 'accepted', providerMessageId: r.messageId, error: null } });
        await tx.conversation.update({ where: { id: conv.id }, data: { lastHumanReplyAt: now, ...(conv.firstHumanReplyAt ? {} : { firstHumanReplyAt: now }) } });
        if (conv.leadId) await tx.lead.updateMany({ where: { id: conv.leadId, firstHumanActionAt: null }, data: { firstHumanActionAt: now } });
      });
      if (conn.mode === 'live') await markLiveVerified(this.d.prisma, conn.id, 'outbound', this.d.clock.now());
      return { kind: 'done', result: { providerMessageId: r.messageId } };
    } catch (err) {
      if (err instanceof ProviderError && err.errorClass !== 'unknown_outcome' && err.errorClass !== 'transient' && err.errorClass !== 'rate_limited') {
        await this.d.prisma.message.update({ where: { id: msg.id }, data: { state: 'failed', error: err.message.slice(0, 300) } });
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
