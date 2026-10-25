import type { PrismaClient } from '@crm/database';

/**
 * Haqiqiy (live) Instagram Direct ulanishi «faol/tayyor» deb faqat HAQIQIY sinovdan keyin ko‘rsatiladi:
 *  - kiruvchi: imzosi to‘g‘ri va akkaunt ID mos kelgan haqiqiy webhook xabari qayta ishlandi;
 *  - chiquvchi: Meta haqiqiy javob xabarini qabul qildi («accepted»).
 * Ikkalasi bo‘lmaguncha ulanish `degraded / awaiting_live_verification` holatida qoladi (credential kiritilgani yetarli emas).
 */
export const AWAITING_LIVE_VERIFICATION = 'awaiting_live_verification';
export const WEBHOOK_UNCONFIRMED = 'webhook_subscription_unconfirmed';
/** Shu sabablar bilan degraded ulanishdan ham javob yuborishga urinish mumkin (aks holda chiquvchi sinov o‘tolmaydi). */
export const SENDABLE_DEGRADED_REASONS: readonly string[] = [AWAITING_LIVE_VERIFICATION, WEBHOOK_UNCONFIRMED];

export interface LiveVerificationSettings {
  verifiedInboundAt?: string | null;
  verifiedOutboundAt?: string | null;
}

export function liveState(settings: unknown, health: string, reason: string | null): 'not_ready' | 'inbound_verified' | 'outbound_verified' | 'ready' | 'problem' {
  const s = (settings ?? {}) as LiveVerificationSettings;
  if (health !== 'ok' && reason && !SENDABLE_DEGRADED_REASONS.includes(reason)) return 'problem';
  if (s.verifiedInboundAt && s.verifiedOutboundAt) return 'ready';
  if (s.verifiedInboundAt) return 'inbound_verified';
  if (s.verifiedOutboundAt) return 'outbound_verified';
  return 'not_ready';
}

export async function markLiveVerified(prisma: PrismaClient, connectionId: string, which: 'inbound' | 'outbound', now: Date): Promise<void> {
  const conn = await prisma.integrationConnection.findUnique({ where: { id: connectionId } });
  if (!conn || conn.provider !== 'META_DIRECT' || conn.mode !== 'live') return;
  const settings = { ...((conn.settings ?? {}) as Record<string, unknown>) } as Record<string, unknown> & LiveVerificationSettings;
  const key = which === 'inbound' ? 'verifiedInboundAt' : 'verifiedOutboundAt';
  if (settings[key]) return;
  settings[key] = now.toISOString();
  const ready = !!settings.verifiedInboundAt && !!settings.verifiedOutboundAt;
  const canPromote = conn.health === 'ok' || (conn.health === 'degraded' && (conn.healthReason === AWAITING_LIVE_VERIFICATION || conn.healthReason === WEBHOOK_UNCONFIRMED));
  await prisma.integrationConnection.update({
    where: { id: conn.id },
    data: { settings: settings as object, ...(ready && canPromote ? { health: 'ok', healthReason: null } : {}) },
  });
}
