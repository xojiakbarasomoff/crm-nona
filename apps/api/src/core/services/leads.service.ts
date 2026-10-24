import { randomUUID } from 'node:crypto';
import type { Channel, Lead, Prisma, Stage, Tx } from '@crm/database';
import {
  addWorkingMinutes,
  automationKey,
  checkTransition,
  detectAnomaly,
  isClosed,
  resumeFromFollowUp,
  shouldApplyRemote,
  stateHash,
  STAGE_LABELS_UZ,
  type LeadFacts,
  type WeeklySchedule,
} from '@crm/domain';
import type { AmoLeadSnapshot } from '@crm/integrations';
import { audit } from '../audit';
import type { Actor, CoreDeps, UserActor } from '../context';
import { headRecipients, notify, publishEvent } from '../events';
import { conflict, forbidden, unprocessable } from '../errors';
import { enqueueOutbox } from '../queue';
import { assertFound, canEditRecord, leadWhere, requireCap } from '../scope';
import { assignNewLead } from './assignment.service';

export interface LeadRequirements {
  serviceType?: string | null;
  origin?: string | null;
  destination?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  adults?: number | null;
  children?: number | null;
  infants?: number | null;
  budgetState?: 'known' | 'undetermined' | null;
  budgetAmount?: string | null;
  budgetCurrency?: string | null;
  notes?: string | null;
  paymentDueAt?: string | null;
}

export interface PendingChange {
  operationKey: string;
  stage?: Stage;
  ownerId?: string;
  requestedBy: string | null;
  requestedAt: string;
}

const req = (l: Pick<Lead, 'requirements'>) => (l.requirements ?? {}) as LeadRequirements;

export async function buildLeadFacts(tx: Tx, lead: Lead): Promise<LeadFacts> {
  const r = req(lead);
  const [sentOffer, acceptedOffer, order] = await Promise.all([
    tx.offer.findFirst({ where: { companyId: lead.companyId, leadId: lead.id, sentAt: { not: null } }, orderBy: { version: 'desc' } }),
    tx.offer.findFirst({ where: { companyId: lead.companyId, leadId: lead.id, acceptedAt: { not: null } }, orderBy: { version: 'desc' } }),
    tx.order.findFirst({ where: { companyId: lead.companyId, leadId: lead.id, fulfillmentState: { not: 'cancelled' } } }),
  ]);
  return {
    stage: lead.stage,
    hasContactOrIdentifier: !!lead.contactId,
    hasSource: !!lead.firstSource,
    ownerId: lead.ownerId,
    contactOutcomeRecorded: !!lead.contactOutcome,
    requirements: {
      serviceType: lead.serviceType ?? r.serviceType ?? null,
      destination: r.destination ?? null,
      dateFrom: r.dateFrom ?? null,
      passengersTotal: (r.adults ?? 0) + (r.children ?? 0) + (r.infants ?? 0) || null,
      budgetState: r.budgetState ?? null,
    },
    offerPrepDueAt: lead.offerPrepDueAt?.toISOString() ?? null,
    sentOfferVersionId: sentOffer?.id ?? null,
    payment: {
      amountMinor: acceptedOffer?.amountMinor ?? null,
      currency: acceptedOffer?.currency ?? null,
      dueAt: r.paymentDueAt ?? null,
      acceptedOfferId: acceptedOffer?.id ?? null,
    },
    order: { exists: !!order, agreedAmountSet: order?.agreedAmountMinor !== null && order?.agreedAmountMinor !== undefined, saleEvidence: !!order?.saleEvidence },
    lostReasonCode: lead.lostReasonCode,
    followUp: { nextContactAt: lead.nextContactAt?.toISOString() ?? null, note: lead.followUpNote },
  };
}

export function leadStateHash(l: { stage: Stage; ownerId: string | null; deletedAt?: Date | null }) {
  return stateHash({ stage: l.stage, ownerId: l.ownerId, deleted: !!l.deletedAt });
}

export class LeadsService {
  constructor(private readonly d: CoreDeps) {}

  /** Creates a NEW lead with assignment, audit, amoCRM create operation and SLA deadline. */
  async createLead(
    tx: Tx,
    p: { companyId: string; contactId: string; name: string; channel: Channel; placement: string; inquiryId: string | null; serviceType: string | null; at: Date; actor: Actor },
  ): Promise<Lead> {
    const decision = await assignNewLead(tx, { companyId: p.companyId, contactId: p.contactId, serviceType: p.serviceType, at: p.at });
    const company = await tx.company.findUniqueOrThrow({ where: { id: p.companyId } });
    const firstResponseDueAt = addWorkingMinutes(company.workSchedule as unknown as WeeklySchedule, p.at, company.slaFirstResponseMinutes);
    const lead = await tx.lead.create({
      data: {
        companyId: p.companyId,
        contactId: p.contactId,
        name: p.name,
        stage: 'NEW',
        ownerId: decision.userId,
        assignmentReason: decision.reason,
        serviceType: p.serviceType,
        firstSource: p.channel,
        firstPlacement: p.placement,
        firstInquiryId: p.inquiryId,
        firstResponseDueAt,
        syncState: 'pending_create',
      },
    });
    await tx.lead.update({ where: { id: lead.id }, data: { stateHash: leadStateHash(lead) } });
    if (decision.userId) {
      await tx.contact.updateMany({ where: { id: p.contactId, ownerId: null }, data: { ownerId: decision.userId } });
    }
    await tx.leadEvent.create({
      data: {
        companyId: p.companyId,
        leadId: lead.id,
        kind: 'created',
        newStage: 'NEW',
        newOwnerId: decision.userId,
        reason: decision.reason,
        origin: 'local',
        algorithmVersion: decision.algorithm,
        effectiveAt: p.at,
      },
    });
    await audit(tx, p.actor, {
      entityType: 'lead',
      entityId: lead.id,
      action: 'assigned',
      newValue: { ownerId: decision.userId, reason: decision.reason, algorithm: decision.algorithm, poolId: decision.poolId },
    });
    await enqueueOutbox(tx, {
      companyId: p.companyId,
      operationKey: `lead.create:${lead.id}`,
      target: 'amocrm',
      action: 'lead.create',
      payload: { leadId: lead.id },
    });
    if (decision.userId) {
      await notify(tx, { companyId: p.companyId, userId: decision.userId, kind: 'lead_assigned', dedupeKey: `lead_assigned:${lead.id}:${decision.userId}`, title: `Yangi lid: ${p.name}`, link: `/leads/${lead.id}` });
    }
    if (decision.alertHead) {
      for (const uid of await headRecipients(tx, p.companyId)) {
        await notify(tx, {
          companyId: p.companyId,
          userId: uid,
          kind: decision.reason === 'duty_fallback' ? 'lead_duty_fallback' : 'lead_awaiting_assignment',
          dedupeKey: `lead_unassigned:${lead.id}:${uid}`,
          title: decision.reason === 'duty_fallback' ? `Lid navbatchiga biriktirildi: ${p.name}` : `Taqsimlash kutilmoqda: ${p.name}`,
          link: `/leads/${lead.id}`,
        });
      }
    }
    return lead;
  }

  async findActiveLeads(tx: Tx, companyId: string, contactId: string) {
    return tx.lead.findMany({ where: { companyId, contactId, deletedAt: null, stage: { notIn: ['WON', 'LOST'] } }, orderBy: { updatedAt: 'desc' } });
  }

  // ---------------- Web actions ----------------

  async list(actor: UserActor, q: { stage?: Stage; ownerId?: string; source?: Channel; search?: string; cursor?: string; limit: number }) {
    const where: Prisma.LeadWhereInput = leadWhere(actor, {
      ...(q.stage ? { stage: q.stage } : {}),
      ...(q.source ? { firstSource: q.source } : {}),
      ...(q.ownerId && actor.role !== 'MANAGER' ? { ownerId: q.ownerId } : {}),
      ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}),
    });
    const rows = await this.d.prisma.lead.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit);
    return { items, nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null };
  }

  async get(actor: UserActor, id: string) {
    const lead = assertFound(await this.d.prisma.lead.findFirst({ where: leadWhere(actor, { id }) }), 'Lid');
    const [events, offers, orders, contact, pendingOps] = await Promise.all([
      this.d.prisma.leadEvent.findMany({ where: { companyId: actor.companyId, leadId: id }, orderBy: { effectiveAt: 'asc' } }),
      this.d.prisma.offer.findMany({ where: { companyId: actor.companyId, leadId: id }, orderBy: { version: 'desc' } }),
      this.d.prisma.order.findMany({ where: { companyId: actor.companyId, leadId: id }, select: { id: true, orderNo: true, fulfillmentState: true } }),
      this.d.prisma.contact.findFirst({ where: { companyId: actor.companyId, id: lead.contactId }, select: { id: true, fullName: true, primaryPhone: true } }),
      this.d.prisma.outboxOperation.findMany({
        where: { companyId: actor.companyId, state: { in: ['pending', 'processing', 'failed', 'unknown', 'paused'] }, payload: { path: ['leadId'], equals: id } },
        select: { id: true, action: true, state: true, lastError: true },
      }),
    ]);
    return { lead, events, offers, orders, contact, pendingOperations: pendingOps };
  }

  /** Local tourism fields are owned by PostgreSQL and change immediately (optimistic lock). */
  async updateDetails(
    actor: UserActor,
    id: string,
    version: number,
    patch: { requirements?: LeadRequirements; serviceType?: string | null; contactOutcome?: string | null; offerPrepDueAt?: Date | null; lostReasonCode?: string | null; lostNote?: string | null; nextContactAt?: Date | null; followUpNote?: string | null },
  ) {
    return this.d.prisma.$transaction(async (tx) => {
      const lead = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id }) }), 'Lid');
      if (!canEditRecord(actor, lead.ownerId)) throw forbidden();
      const data: Prisma.LeadUpdateInput = { version: { increment: 1 } };
      if (patch.requirements) data.requirements = { ...req(lead), ...patch.requirements } as Prisma.InputJsonValue;
      if (patch.serviceType !== undefined) data.serviceType = patch.serviceType;
      if (patch.contactOutcome !== undefined) data.contactOutcome = patch.contactOutcome;
      if (patch.offerPrepDueAt !== undefined) data.offerPrepDueAt = patch.offerPrepDueAt;
      if (patch.lostReasonCode !== undefined) data.lostReasonCode = patch.lostReasonCode;
      if (patch.lostNote !== undefined) data.lostNote = patch.lostNote;
      if (patch.nextContactAt !== undefined) data.nextContactAt = patch.nextContactAt;
      if (patch.followUpNote !== undefined) data.followUpNote = patch.followUpNote;
      if (patch.contactOutcome && !lead.firstHumanActionAt) data.firstHumanActionAt = this.d.clock.now();
      const res = await tx.lead.updateMany({ where: { id, version }, data: data as Prisma.LeadUpdateManyMutationInput });
      if (res.count !== 1) throw conflict('VERSION_CONFLICT', 'Lid boshqa foydalanuvchi tomonidan o‘zgartirilgan. Sahifani yangilang.');
      await audit(tx, actor, { entityType: 'lead', entityId: id, action: 'details_updated', oldValue: pick(lead, Object.keys(patch)), newValue: patch });
      return tx.lead.findUniqueOrThrow({ where: { id } });
    });
  }

  /**
   * Stage change requested in the web app. amoCRM owns the stage: the request is validated, stored
   * as a pending change and sent through the outbox. The projection changes only after amoCRM
   * confirms (TZ §5.1). UI shows «Sinxronlanmoqda» meanwhile.
   */
  async requestStageChange(actor: UserActor, id: string, version: number, target: Stage, extra: { reason?: string | null } = {}) {
    return this.d.prisma.$transaction(async (tx) => {
      const lead = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id }) }), 'Lid');
      if (!canEditRecord(actor, lead.ownerId)) throw forbidden();
      if (lead.version !== version) throw conflict('VERSION_CONFLICT', 'Lid boshqa foydalanuvchi tomonidan o‘zgartirilgan. Sahifani yangilang.');
      if (lead.pendingChange) throw conflict('SYNC_IN_PROGRESS', 'Oldingi o‘zgarish hali amoCRM bilan sinxronlanmoqda');
      const facts = await buildLeadFacts(tx, lead);
      const check = checkTransition(lead.stage, target, facts, lead.returnStage);
      if (!check.ok) {
        if (check.code === 'MISSING_FIELDS') {
          throw unprocessable('MISSING_FIELDS', `«${STAGE_LABELS_UZ[target]}» bosqichiga o‘tish uchun majburiy maydonlar to‘ldirilmagan`, Object.fromEntries((check.missing ?? []).map((m) => [m, 'required'])));
        }
        if (check.code === 'CLOSED_REQUIRES_REOPEN') throw unprocessable('CLOSED_REQUIRES_REOPEN', 'Yopilgan lidni faqat rahbar sabab bilan qayta ochadi');
        throw unprocessable(check.code, 'Bosqich o‘zgarishi mumkin emas');
      }
      const operationKey = `lead.stage:${id}:${lead.version}:${target}`;
      const pending: PendingChange = { operationKey, stage: target, requestedBy: actor.id, requestedAt: this.d.clock.now().toISOString() };
      await tx.lead.update({
        where: { id },
        data: { pendingChange: pending as unknown as Prisma.InputJsonValue, syncState: lead.amoLeadId ? 'pending' : lead.syncState, returnStage: check.returnStage ?? (lead.stage === 'FOLLOW_UP' ? null : lead.returnStage), version: { increment: 1 } },
      });
      await enqueueOutbox(tx, { companyId: actor.companyId, operationKey, target: 'amocrm', action: 'lead.stage', payload: { leadId: id, stage: target, reason: extra.reason ?? null, requestedBy: actor.id } });
      await audit(tx, actor, { entityType: 'lead', entityId: id, action: 'stage_change_requested', oldValue: { stage: lead.stage }, newValue: { stage: target } });
      return tx.lead.findUniqueOrThrow({ where: { id } });
    });
  }

  async requestReassign(actor: UserActor, id: string, toUserId: string, reason: string) {
    requireCap(actor, 'leads.reassign');
    return this.d.prisma.$transaction(async (tx) => {
      const lead = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id }) }), 'Lid');
      const target = await tx.user.findFirst({ where: { id: toUserId, companyId: actor.companyId, status: 'active' } });
      if (!target) throw unprocessable('ASSIGNEE_INVALID', 'Tanlangan xodim faol emas', { toUserId: 'invalid' });
      if (lead.ownerId === toUserId) return lead;
      const operationKey = `lead.reassign:${id}:${lead.version}:${toUserId}`;
      const pending: PendingChange = { operationKey, ownerId: toUserId, requestedBy: actor.id, requestedAt: this.d.clock.now().toISOString() };
      await tx.lead.update({ where: { id }, data: { pendingChange: pending as unknown as Prisma.InputJsonValue, syncState: lead.amoLeadId ? 'pending' : lead.syncState, version: { increment: 1 } } });
      await enqueueOutbox(tx, { companyId: actor.companyId, operationKey, target: 'amocrm', action: 'lead.reassign', payload: { leadId: id, toUserId, reason } });
      await audit(tx, actor, { entityType: 'lead', entityId: id, action: 'reassign_requested', oldValue: { ownerId: lead.ownerId }, newValue: { ownerId: toUserId, reason } });
      return tx.lead.findUniqueOrThrow({ where: { id } });
    });
  }

  async requestReopen(actor: UserActor, id: string, reason: string, toStage: Stage = 'CONTACTED') {
    requireCap(actor, 'leads.reopen');
    if (!reason?.trim()) throw unprocessable('REASON_REQUIRED', 'Qayta ochish sababi majburiy', { reason: 'required' });
    return this.d.prisma.$transaction(async (tx) => {
      const lead = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id }) }), 'Lid');
      if (!isClosed(lead.stage)) throw unprocessable('NOT_CLOSED', 'Lid yopilmagan');
      if (isClosed(toStage)) throw unprocessable('INVALID_TARGET', 'Qayta ochishda ochiq bosqich tanlanadi');
      const operationKey = `lead.reopen:${id}:${lead.version}`;
      const pending: PendingChange = { operationKey, stage: toStage, requestedBy: actor.id, requestedAt: this.d.clock.now().toISOString() };
      await tx.lead.update({ where: { id }, data: { pendingChange: pending as unknown as Prisma.InputJsonValue, syncState: 'pending', version: { increment: 1 } } });
      await enqueueOutbox(tx, { companyId: actor.companyId, operationKey, target: 'amocrm', action: 'lead.stage', payload: { leadId: id, stage: toStage, reason, reopen: true, requestedBy: actor.id } });
      await audit(tx, actor, { entityType: 'lead', entityId: id, action: 'reopen_requested', oldValue: { stage: lead.stage }, newValue: { stage: toStage, reason } });
      return tx.lead.findUniqueOrThrow({ where: { id } });
    });
  }

  // ---------------- Remote (amoCRM) projection ----------------

  /**
   * Applies an amoCRM lead snapshot. Older snapshots never roll back newer state (AC30). Status or
   * owner changes are recorded with previous values; missing required data becomes an anomaly with
   * a correction task, never a silent revert (AC14). Owner changes cascade to orders, segments and
   * active reminders without rewriting historical authorship (AC13).
   */
  async applyRemoteSnapshot(tx: Tx, companyId: string, snap: AmoLeadSnapshot, ctx: { origin: 'amocrm' | 'local_confirmed' | 'reconcile'; operationKey?: string | null }) {
    const lead = await tx.lead.findFirst({ where: { companyId, amoLeadId: snap.id } });
    if (!lead) return { applied: false, reason: 'unknown_lead' as const };
    await tx.$executeRaw`SELECT 1 FROM leads WHERE id = ${lead.id}::uuid FOR UPDATE`;
    const fresh = await tx.lead.findUniqueOrThrow({ where: { id: lead.id } });

    if (snap.deleted) {
      if (!fresh.deletedAt) {
        await tx.lead.update({ where: { id: fresh.id }, data: { deletedAt: this.d.clock.now(), syncState: 'synced' } });
        await audit(tx, { type: 'integration', id: null, companyId, name: 'amocrm' }, { entityType: 'lead', entityId: fresh.id, action: 'tombstoned' });
        const activeOrder = await tx.order.findFirst({ where: { companyId, leadId: fresh.id, fulfillmentState: { notIn: ['cancelled', 'completed'] } } });
        if (activeOrder) {
          for (const uid of await headRecipients(tx, companyId)) {
            await notify(tx, { companyId, userId: uid, kind: 'deleted_lead_with_order', dedupeKey: `deleted_lead:${fresh.id}:${uid}`, title: `amoCRM’da o‘chirilgan lidda faol buyurtma bor: ${activeOrder.orderNo}`, link: `/orders/${activeOrder.id}` });
          }
        }
      }
      return { applied: true, reason: 'tombstoned' as const };
    }

    const stage = await this.stageForStatus(tx, companyId, snap.pipelineId, snap.statusId);
    const owner = snap.responsibleUserId ? await tx.user.findFirst({ where: { companyId, amoUserId: snap.responsibleUserId }, select: { id: true } }) : null;
    const next = { stage: stage ?? fresh.stage, ownerId: owner?.id ?? fresh.ownerId };
    const hash = leadStateHash(next);
    if (!shouldApplyRemote({ sourceUpdatedAt: fresh.sourceUpdatedAt, stateHash: fresh.stateHash }, { sourceUpdatedAt: snap.updatedAt, stateHash: hash })) {
      return { applied: false, reason: 'stale' as const };
    }

    const now = this.d.clock.now();
    const pending = fresh.pendingChange as PendingChange | null;
    const pendingResolved = !!pending && (pending.stage === undefined || pending.stage === next.stage) && (pending.ownerId === undefined || pending.ownerId === next.ownerId);
    const data: Prisma.LeadUncheckedUpdateInput = {
      sourceUpdatedAt: snap.updatedAt,
      stateHash: hash,
      syncState: pending && !pendingResolved ? 'pending' : 'synced',
      ...(pendingResolved ? { pendingChange: null as unknown as Prisma.InputJsonValue } : {}),
    };
    const actor = { type: 'integration' as const, id: null, companyId, name: 'amocrm' };
    const transitionId = `${snap.id}:${snap.updatedAt.getTime()}`;

    if (stage && stage !== fresh.stage) {
      data.stage = stage;
      if (isClosed(stage)) data.closedAt = snap.closedAt ?? snap.updatedAt;
      if (stage === 'WON' && !fresh.firstWonAt) data.firstWonAt = snap.closedAt ?? snap.updatedAt;
      if (!isClosed(stage) && isClosed(fresh.stage)) data.closedAt = null;
      if (fresh.stage === 'FOLLOW_UP' && stage !== 'FOLLOW_UP') data.returnStage = null;
      await tx.leadEvent.create({
        data: {
          companyId,
          leadId: fresh.id,
          kind: isClosed(fresh.stage) && !isClosed(stage) ? 'reopened' : 'stage_change',
          oldStage: fresh.stage,
          newStage: stage,
          origin: ctx.origin === 'local_confirmed' ? 'local' : 'amocrm',
          operationId: ctx.operationKey ?? null,
          actorId: pending?.requestedBy ?? null,
          effectiveAt: snap.updatedAt,
          observedAt: now,
        },
      });
      await audit(tx, actor, { entityType: 'lead', entityId: fresh.id, action: 'stage_changed', oldValue: { stage: fresh.stage }, newValue: { stage, origin: ctx.origin } });

      if (stage === 'LOST') await this.cancelOpenSalesTasks(tx, companyId, fresh.id);
      if (stage === 'WON') await this.ensureOrderForWon(tx, companyId, fresh, now);
      if (ctx.origin !== 'local_confirmed') {
        const facts = await buildLeadFacts(tx, { ...fresh, stage });
        const missing = detectAnomaly(stage, facts);
        if (missing.length) {
          data.anomaly = { stage, missing, detectedAt: now.toISOString() } as Prisma.InputJsonValue;
          await this.createCrmTask(tx, {
            companyId,
            key: automationKey(fresh.id, 'anomaly_fix', transitionId),
            entityId: fresh.id,
            kind: 'anomaly_fix',
            text: `amoCRM’da «${STAGE_LABELS_UZ[stage]}» bosqichi uchun ma’lumot yetishmaydi: ${missing.join(', ')}. Tuzating.`,
            responsibleUserId: next.ownerId,
            dueAt: new Date(now.getTime() + 3600_000),
          });
          await audit(tx, actor, { entityType: 'lead', entityId: fresh.id, action: 'anomaly_detected', newValue: { stage, missing } });
        } else {
          data.anomaly = null as unknown as Prisma.InputJsonValue;
        }
      }
      if (stage === 'FOLLOW_UP') {
        await this.createCrmTask(tx, {
          companyId,
          key: automationKey(fresh.id, 'follow_up', transitionId),
          entityId: fresh.id,
          kind: 'follow_up',
          text: `Qayta aloqa: ${fresh.followUpNote ?? ''}`.trim(),
          responsibleUserId: next.ownerId,
          dueAt: fresh.nextContactAt ?? new Date(now.getTime() + 24 * 3600_000),
        });
      }
    }

    if (owner && owner.id !== fresh.ownerId) {
      data.ownerId = owner.id;
      await tx.leadEvent.create({
        data: { companyId, leadId: fresh.id, kind: 'owner_change', oldOwnerId: fresh.ownerId, newOwnerId: owner.id, origin: ctx.origin === 'local_confirmed' ? 'local' : 'amocrm', operationId: ctx.operationKey ?? null, actorId: pending?.requestedBy ?? null, effectiveAt: snap.updatedAt, observedAt: now },
      });
      await this.cascadeOwner(tx, companyId, fresh.id, fresh.ownerId, owner.id);
      await audit(tx, actor, { entityType: 'lead', entityId: fresh.id, action: 'owner_changed', oldValue: { ownerId: fresh.ownerId }, newValue: { ownerId: owner.id, origin: ctx.origin } });
    } else if (snap.responsibleUserId && !owner) {
      await audit(tx, actor, { entityType: 'lead', entityId: fresh.id, action: 'owner_unmapped', newValue: { amoUserId: snap.responsibleUserId } });
    }

    await tx.lead.update({ where: { id: fresh.id }, data: { ...data, version: { increment: 1 } } });
    await publishEvent(this.d.redis, { companyId, entityType: 'lead', entityId: fresh.id, ownerId: next.ownerId, kind: 'updated' });
    return { applied: true, reason: 'applied' as const };
  }

  async stageForStatus(tx: Tx, companyId: string, pipelineId: string, statusId: string): Promise<Stage | null> {
    const m = await tx.integrationMapping.findUnique({ where: { companyId_entityType_externalId: { companyId, entityType: 'pipeline_status', externalId: `${pipelineId}:${statusId}` } } });
    return (m?.localId as Stage | undefined) ?? null;
  }

  async statusForStage(tx: Tx, companyId: string, stage: Stage): Promise<{ pipelineId: string; statusId: string } | null> {
    const m = await tx.integrationMapping.findFirst({ where: { companyId, entityType: 'pipeline_status', localId: stage } });
    if (!m) return null;
    const [pipelineId, statusId] = m.externalId.split(':');
    return { pipelineId: pipelineId!, statusId: statusId! };
  }

  /** Owner change cascades to local order, segments, active reminders and open CRM tasks. */
  async cascadeOwner(tx: Tx, companyId: string, leadId: string, fromUserId: string | null, toUserId: string) {
    const orders = await tx.order.findMany({ where: { companyId, leadId, fulfillmentState: { notIn: ['completed', 'cancelled'] } }, select: { id: true } });
    const orderIds = orders.map((o) => o.id);
    await tx.order.updateMany({ where: { id: { in: orderIds } }, data: { ownerId: toUserId } });
    await tx.flightSegment.updateMany({ where: { companyId, orderId: { in: orderIds }, active: true }, data: { ownerId: toUserId } });
    const occ = await tx.reminderOccurrence.findMany({
      where: { companyId, orderId: { in: orderIds }, state: { in: ['scheduled', 'dispatching', 'due', 'snoozed'] }, ...(fromUserId ? { assigneeId: fromUserId } : {}) },
      select: { id: true },
    });
    await tx.reminderOccurrence.updateMany({ where: { id: { in: occ.map((o) => o.id) } }, data: { assigneeId: toUserId } });
    const tasks = await tx.crmTask.findMany({ where: { companyId, entityId: leadId, state: { in: ['pending', 'open'] } } });
    for (const t of tasks) {
      await tx.crmTask.update({ where: { id: t.id }, data: { responsibleUserId: toUserId } });
      if (t.amoTaskId) {
        await enqueueOutbox(tx, { companyId, operationKey: `task.reassign:${t.id}:${toUserId}`, target: 'amocrm', action: 'task.reassign', payload: { crmTaskId: t.id, toUserId } });
      }
    }
  }

  async cancelOpenSalesTasks(tx: Tx, companyId: string, leadId: string) {
    const tasks = await tx.crmTask.findMany({ where: { companyId, entityId: leadId, state: { in: ['pending', 'open'] }, kind: { in: ['first_contact', 'follow_up', 'offer_prep'] } } });
    for (const t of tasks) {
      await tx.crmTask.update({ where: { id: t.id }, data: { state: 'cancelled' } });
      if (t.amoTaskId) await enqueueOutbox(tx, { companyId, operationKey: `task.complete:${t.id}`, target: 'amocrm', action: 'task.complete', payload: { crmTaskId: t.id, result: 'Lid bekor qilindi' } });
    }
  }

  /** WON without a local order → idempotent draft order (TZ §12.3, AC15). */
  async ensureOrderForWon(tx: Tx, companyId: string, lead: Lead, now: Date) {
    const existing = await tx.order.findFirst({ where: { companyId, leadId: lead.id, fulfillmentState: { not: 'cancelled' } } });
    if (existing) return existing;
    const { createOrderRow } = await import('./orders.service');
    return createOrderRow(tx, { companyId, leadId: lead.id, contactId: lead.contactId, ownerId: lead.ownerId, now, fulfillmentState: 'draft' });
  }

  async createCrmTask(tx: Tx, t: { companyId: string; key: string; entityId: string; kind: string; text: string; responsibleUserId: string | null; dueAt: Date; entityType?: string }) {
    const res = await tx.crmTask.createMany({
      data: [{ companyId: t.companyId, automationKey: t.key, entityType: t.entityType ?? 'lead', entityId: t.entityId, kind: t.kind, text: t.text, responsibleUserId: t.responsibleUserId, dueAt: t.dueAt, state: 'pending' }],
      skipDuplicates: true,
    });
    if (res.count === 0) return null;
    const task = await tx.crmTask.findUniqueOrThrow({ where: { companyId_automationKey: { companyId: t.companyId, automationKey: t.key } } });
    await enqueueOutbox(tx, { companyId: t.companyId, operationKey: `task.create:${task.id}`, target: 'amocrm', action: 'task.create', payload: { crmTaskId: task.id } });
    return task;
  }

  newCorrelationId() {
    return randomUUID();
  }
}

function pick(obj: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

export { resumeFromFollowUp };
