import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Tx } from '@crm/database';
import { encryptSecret } from '@crm/database';
import { toJson } from './audit';

/**
 * Durable inbox and transactional outbox (TZ §19.1).
 * - Inbox: a validated webhook event is committed to PostgreSQL *before* the HTTP 2xx.
 * - Outbox: side effects to providers are written in the same transaction as the business change;
 *   the worker relays them. A unique operation_key makes enqueueing idempotent.
 */

export interface InboxInput {
  provider: string;
  connectionKey: string;
  companyId: string | null;
  externalEventId: string;
  eventType: string;
  payload: unknown;
  correlationId?: string;
}

/** Returns true when stored, false when it was a duplicate delivery. Throws if the DB is unavailable. */
export async function storeInboxEvent(prisma: PrismaClient | Tx, key: Buffer, e: InboxInput): Promise<boolean> {
  const rows = await (prisma as PrismaClient).$executeRaw`
    INSERT INTO webhook_inbox (id, company_id, provider, connection_key, external_event_id, event_type, payload_enc, state, attempts, next_attempt_at, correlation_id, received_at)
    VALUES (${randomUUID()}::uuid, ${e.companyId}::uuid, ${e.provider}, ${e.connectionKey}, ${e.externalEventId}, ${e.eventType},
            ${encryptSecret(JSON.stringify(e.payload), key)}, 'pending', 0, now(), ${e.correlationId ?? randomUUID()}, now())
    ON CONFLICT (provider, connection_key, external_event_id) DO NOTHING`;
  return rows > 0;
}

export interface OutboxInput {
  companyId: string;
  operationKey: string;
  target: string;
  action: string;
  payload: Record<string, unknown>;
  connectionId?: string | null;
  correlationId?: string;
  notBefore?: Date;
}

/** Idempotent: a second enqueue with the same operation_key is a no-op. Returns the operation id. */
export async function enqueueOutbox(tx: Tx, o: OutboxInput): Promise<string> {
  const existing = await tx.outboxOperation.findUnique({ where: { companyId_operationKey: { companyId: o.companyId, operationKey: o.operationKey } }, select: { id: true } });
  if (existing) return existing.id;
  const id = randomUUID();
  await (tx as PrismaClient).$executeRaw`
    INSERT INTO outbox_operations (id, company_id, operation_key, connection_id, target, action, payload, state, attempts, next_attempt_at, correlation_id, created_at, updated_at)
    VALUES (${id}::uuid, ${o.companyId}::uuid, ${o.operationKey}, ${o.connectionId ?? null}::uuid, ${o.target}, ${o.action}, ${JSON.stringify(toJson(o.payload) ?? {})}::jsonb,
            'pending', 0, ${o.notBefore ?? new Date()}, ${o.correlationId ?? randomUUID()}, now(), now())
    ON CONFLICT (company_id, operation_key) DO NOTHING`;
  const row = await tx.outboxOperation.findUnique({ where: { companyId_operationKey: { companyId: o.companyId, operationKey: o.operationKey } }, select: { id: true } });
  return row!.id;
}

export type OutboxRow = Prisma.OutboxOperationGetPayload<object>;
export type InboxRow = Prisma.WebhookInboxGetPayload<object>;
