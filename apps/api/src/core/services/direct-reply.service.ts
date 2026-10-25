import type { Conversation, Lead } from '@crm/database';
import { can, decideOutbound, type MessagingPolicyConfig } from '@crm/domain';
import { audit } from '../audit';
import type { CoreDeps, UserActor } from '../context';
import { publishEvent } from '../events';
import { forbidden, unprocessable } from '../errors';
import { enqueueOutbox } from '../queue';
import { assertFound, canEditRecord, leadWhere } from '../scope';
import { SENDABLE_DEGRADED_REASONS } from './live-verification';

const policyConfig = (d: CoreDeps): MessagingPolicyConfig => ({
  standardWindowHours: d.config.meta.standardWindowHours,
  humanAgentWindowHours: d.config.meta.humanAgentWindowHours,
  humanAgentPermissionGranted: d.config.meta.humanAgentGranted,
});

/** Можно ли сейчас ответить клиенту в этой беседе (правила Meta: окно ответа, подключение, права). */
export async function replyDecision(d: CoreDeps, actor: UserActor, lead: Pick<Lead, 'ownerId'>, conv: Conversation, cfg: MessagingPolicyConfig = policyConfig(d)) {
  const conn = await d.prisma.integrationConnection.findUnique({ where: { id: conv.connectionId }, select: { health: true, healthReason: true, disconnectedAt: true, mode: true } });
  const healthy = !!conn && !conn.disconnectedAt && (conn.health === 'ok' || (conn.health === 'degraded' && !!conn.healthReason && SENDABLE_DEGRADED_REASONS.includes(conn.healthReason)));
  const decision = decideOutbound(
    {
      now: d.clock.now(),
      lastCustomerMessageAt: conv.lastInboundAt,
      purpose: 'human_reply',
      connectionHealthy: healthy,
      senderMayReply: can(actor.role, 'leads.work') && canEditRecord(actor, lead.ownerId),
      recipientScopedIdVerified: !!conv.scopedPeerId,
    },
    cfg,
  );
  return decision.allowed
    ? { allowed: true as const, tag: decision.tag, mode: conn?.mode ?? null, reason: null, message: null }
    : { allowed: false as const, tag: null, mode: conn?.mode ?? null, reason: decision.reason, message: decision.message };
}

export class DirectReplyService {
  constructor(private readonly d: CoreDeps) {}

  /**
   * Текстовый ответ клиенту из карточки лида. Сообщение сохраняется как «queued» и отправляется через
   * outbox (`meta.send`); «Отправлено» появляется только когда Instagram принял сообщение. Один ключ
   * идемпотентности = одно сообщение: повтор запроса не отправляет второй раз.
   */
  async send(actor: UserActor, leadId: string, input: { text: string; conversationId?: string | null }, idempotencyKey: string) {
    const lead = assertFound(await this.d.prisma.lead.findFirst({ where: leadWhere(actor, { id: leadId }) }), 'Лид');
    if (!can(actor.role, 'leads.work') || !canEditRecord(actor, lead.ownerId)) throw forbidden();
    const convs = await this.d.prisma.conversation.findMany({ where: { companyId: actor.companyId, contactId: lead.contactId }, orderBy: [{ lastInboundAt: { sort: 'desc', nulls: 'last' } }] });
    const conv = input.conversationId ? convs.find((c) => c.id === input.conversationId) : convs[0];
    if (!conv) throw unprocessable('NO_CONVERSATION', 'У этого клиента нет переписки в Instagram', { conversationId: 'missing' });
    const operationId = `reply:${idempotencyKey}`;
    const decision = await replyDecision(this.d, actor, lead, conv);

    const message = await this.d.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reply:${conv.id}:${operationId}`}, 0))`;
      const existing = await tx.message.findFirst({ where: { companyId: actor.companyId, conversationId: conv.id, operationId } });
      if (existing) return existing;
      const msg = await tx.message.create({
        data: {
          companyId: actor.companyId,
          conversationId: conv.id,
          connectionId: conv.connectionId,
          direction: 'outbound',
          type: 'text',
          content: input.text,
          state: decision.allowed ? 'queued' : 'failed',
          error: decision.allowed ? null : decision.message,
          actorType: 'human',
          actorUserId: actor.id,
          operationId,
        },
      });
      if (decision.allowed) {
        await enqueueOutbox(tx, { companyId: actor.companyId, connectionId: conv.connectionId, operationKey: `direct.send:${msg.id}`, target: 'meta', action: 'meta.send', payload: { messageId: msg.id, tag: decision.tag }, correlationId: msg.id });
      }
      await audit(tx, actor, { entityType: 'message', entityId: msg.id, action: decision.allowed ? 'reply_queued' : 'reply_rejected', newValue: { leadId, conversationId: conv.id, reason: decision.reason } });
      return msg;
    });
    await publishEvent(this.d.redis, { companyId: actor.companyId, entityType: 'lead', entityId: leadId, ownerId: lead.ownerId, kind: 'updated' });
    return message;
  }
}
