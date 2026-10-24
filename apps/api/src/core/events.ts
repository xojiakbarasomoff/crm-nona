import type { Redis } from 'ioredis';
import type { Tx } from '@crm/database';

/**
 * Realtime change signals for SSE (TZ §15.3). Events carry only identifiers; the SSE endpoint
 * re-checks access for every event before forwarding (an owner change takes effect immediately).
 */
export interface ChangeEvent {
  companyId: string;
  entityType: 'lead' | 'order' | 'segment' | 'reminder' | 'notification' | 'integration' | 'conversation';
  entityId: string;
  /** Owner at the time of the event; informative only, never trusted for access. */
  ownerId?: string | null;
  userId?: string | null;
  kind: string;
  at: string;
}

export const eventsChannel = (companyId: string) => `events:${companyId}`;

export async function publishEvent(redis: Redis, e: Omit<ChangeEvent, 'at'>): Promise<void> {
  try {
    await redis.publish(eventsChannel(e.companyId), JSON.stringify({ ...e, at: new Date().toISOString() }));
  } catch {
    // SSE is best effort: the UI falls back to 30 s polling.
  }
}

/** In-app notification (idempotent by dedupe key). */
export async function notify(
  tx: Tx,
  n: { companyId: string; userId: string; kind: string; dedupeKey: string; title: string; body?: string | null; link?: string | null; occurrenceId?: string | null },
): Promise<boolean> {
  const res = await tx.notification.createMany({
    data: [{ companyId: n.companyId, userId: n.userId, kind: n.kind, dedupeKey: n.dedupeKey, title: n.title, body: n.body ?? null, link: n.link ?? null, occurrenceId: n.occurrenceId ?? null }],
    skipDuplicates: true,
  });
  return res.count > 0;
}

/** Users who receive head-of-sales signals: active HEAD users plus the configured duty user. */
export async function headRecipients(tx: Tx, companyId: string): Promise<string[]> {
  const company = await tx.company.findUnique({ where: { id: companyId }, select: { dutyUserId: true } });
  const heads = await tx.user.findMany({ where: { companyId, role: 'HEAD', status: 'active' }, select: { id: true } });
  return [...new Set([...heads.map((h) => h.id), ...(company?.dutyUserId ? [company.dutyUserId] : [])])];
}
