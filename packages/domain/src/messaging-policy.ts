/**
 * Outbound Instagram messaging policy (TZ §9.2, AC07).
 *
 * Window lengths are configuration, not hard-coded facts: they must be confirmed for the chosen
 * Meta product in G07 and stored in `docs/feasibility.md`. Human Agent may only be used for a real
 * human reply when the permission is granted; never for automated promo or flight reminders.
 */

export interface MessagingPolicyConfig {
  standardWindowHours: number;
  humanAgentWindowHours: number | null;
  humanAgentPermissionGranted: boolean;
}

export type OutboundPurpose = 'human_reply' | 'automated_reminder' | 'promotion';

export interface OutboundContext {
  now: Date;
  lastCustomerMessageAt: Date | null;
  purpose: OutboundPurpose;
  connectionHealthy: boolean;
  senderMayReply: boolean;
  recipientScopedIdVerified: boolean;
}

export type PolicyDecision =
  | { allowed: true; tag: null | 'HUMAN_AGENT' }
  | {
      allowed: false;
      reason: 'no_permission' | 'connection_down' | 'recipient_unverified' | 'no_customer_message' | 'window_closed' | 'automated_not_allowed';
      message: string;
    };

export function decideOutbound(ctx: OutboundContext, cfg: MessagingPolicyConfig): PolicyDecision {
  if (!ctx.senderMayReply) return { allowed: false, reason: 'no_permission', message: 'У вас нет прав отвечать в этой переписке.' };
  if (!ctx.connectionHealthy) return { allowed: false, reason: 'connection_down', message: 'Подключение Instagram неактивно.' };
  if (!ctx.recipientScopedIdVerified) return { allowed: false, reason: 'recipient_unverified', message: 'Получатель не определён по подтверждённому Instagram ID.' };
  if (!ctx.lastCustomerMessageAt) return { allowed: false, reason: 'no_customer_message', message: 'Клиент ещё не писал; первое сообщение отправить нельзя.' };
  if (ctx.purpose !== 'human_reply') {
    return { allowed: false, reason: 'automated_not_allowed', message: 'Автоматические сообщения через Instagram не отправляются; работает внутреннее напоминание.' };
  }
  const elapsedH = (ctx.now.getTime() - ctx.lastCustomerMessageAt.getTime()) / 3_600_000;
  if (elapsedH <= cfg.standardWindowHours) return { allowed: true, tag: null };
  if (cfg.humanAgentPermissionGranted && cfg.humanAgentWindowHours && elapsedH <= cfg.humanAgentWindowHours) {
    return { allowed: true, tag: 'HUMAN_AGENT' };
  }
  return {
    allowed: false,
    reason: 'window_closed',
    message: `Окно ответа закрыто: с последнего сообщения клиента прошло ${Math.floor(elapsedH)} ч.`,
  };
}
