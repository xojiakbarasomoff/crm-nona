import { randomUUID } from 'node:crypto';
import type { Prisma, Tx } from '@crm/database';
import type { Actor } from './context';

/**
 * Append-only audit (TZ §21). The database trigger rejects UPDATE/DELETE on audit_logs.
 */
export interface AuditEntry {
  entityType: string;
  entityId: string;
  action: string;
  oldValue?: unknown;
  newValue?: unknown;
  correlationId?: string;
}

const toJson = (v: unknown): Prisma.InputJsonValue | undefined =>
  v === undefined ? undefined : (JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))) as Prisma.InputJsonValue);

export async function audit(tx: Tx, actor: Actor, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      companyId: actor.companyId,
      actorType: actor.type,
      actorId: actor.type === 'user' ? actor.id : null,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      oldValue: toJson(entry.oldValue),
      newValue: toJson(entry.newValue),
      correlationId: entry.correlationId ?? actor.requestId ?? randomUUID(),
      requestId: actor.requestId ?? null,
      ip: actor.type === 'user' ? (actor.ip ?? null) : null,
    },
  });
}

export { toJson };
