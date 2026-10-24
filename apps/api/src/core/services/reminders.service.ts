import { randomUUID } from 'node:crypto';
import type { Prisma, ReminderOccurrence, Tx } from '@crm/database';
import {
  checkOccurrenceValidity,
  formatAirportTimeUz,
  milestoneDedupeKey,
  nthOccurrence,
  planMilestones,
  snoozeUntil,
  URGENT_MILESTONE,
  validateRecurrence,
  can,
  type MilestoneRule,
  type Recurrence,
} from '@crm/domain';
import { audit } from '../audit';
import { systemActor, type Actor, type CoreDeps, type UserActor } from '../context';
import { headRecipients, notify, publishEvent } from '../events';
import { forbidden, unprocessable } from '../errors';
import { enqueueOutbox } from '../queue';
import { assertFound, canEditRecord, orderWhere, requireCap } from '../scope';

const ACTIVE_STATES = ['scheduled', 'dispatching', 'due', 'snoozed'] as const;
const PLANNABLE_ORDER_STATES = ['confirmed', 'in_progress'];

/**
 * Reminder planning and the DB-backed scheduler (TZ §14, ADR 0004).
 */
export class RemindersService {
  constructor(private readonly d: CoreDeps) {}

  async currentRules(tx: Tx, companyId: string): Promise<Array<MilestoneRule & { version: number }>> {
    const rows = await tx.reminderRule.findMany({ where: { companyId, current: true } });
    return rows.map((r) => ({ milestone: r.milestone, offsetSeconds: r.offsetSeconds, enabled: r.enabled, escalateAfterMinutes: r.escalateAfterMinutes, version: r.version }));
  }

  // ---------------- Planning ----------------

  async planForOrder(companyId: string, orderId: string) {
    const segments = await this.d.prisma.flightSegment.findMany({ where: { companyId, orderId, active: true }, select: { id: true } });
    for (const s of segments) await this.d.prisma.$transaction((tx) => this.planForSegment(tx, companyId, s.id));
  }

  /**
   * Plans milestone occurrences for the segment's current revision. Idempotent thanks to the unique
   * key (company, segment, revision, rule_version, milestone).
   */
  async planForSegment(tx: Tx, companyId: string, segmentId: string, opts: { allowUrgent?: boolean } = {}) {
    const segment = await tx.flightSegment.findFirst({ where: { id: segmentId, companyId } });
    if (!segment || !segment.active || segment.operationalStatus === 'cancelled') return { planned: 0 };
    const order = await tx.order.findFirstOrThrow({ where: { id: segment.orderId, companyId } });
    if (!PLANNABLE_ORDER_STATES.includes(order.fulfillmentState)) return { planned: 0 };
    const now = this.d.clock.now();
    const assigneeId = segment.ownerId ?? order.ownerId;

    if (!segment.departureAtUtc) {
      const { LeadsService } = await import('./leads.service');
      await new LeadsService(this.d).createCrmTask(tx, {
        companyId,
        key: `segment:${segment.id}:rev:${segment.scheduleRevision}:missing_departure`,
        entityId: order.leadId,
        kind: 'missing_departure',
        text: `Reys vaqti kiritilmagan: ${order.orderNo}, ${segment.originIata}–${segment.destinationIata} ${segment.marketingCarrier} ${segment.flightNumber}`,
        responsibleUserId: assigneeId,
        dueAt: new Date(now.getTime() + 3600_000),
      });
      if (assigneeId) {
        await notify(tx, { companyId, userId: assigneeId, kind: 'missing_departure', dedupeKey: `missing_departure:${segment.id}:${segment.scheduleRevision}`, title: `Reys vaqti kiritilmagan: ${order.orderNo}`, link: `/orders/${order.id}` });
      }
      return { planned: 0 };
    }

    const rules = await this.currentRules(tx, companyId);
    const planned = planMilestones(segment.departureAtUtc, now, rules);
    const contact = await tx.contact.findFirst({ where: { id: order.contactId, companyId }, select: { fullName: true } });
    const versionOf = (m: string) => rules.find((r) => r.milestone === m)?.version ?? 0;
    const data = planned
      .filter((p) => opts.allowUrgent !== false || p.milestone !== URGENT_MILESTONE)
      .map((p) => {
        const ruleVersion = p.milestone === URGENT_MILESTONE ? 0 : versionOf(p.milestone);
        return {
          companyId,
          kind: 'milestone' as const,
          orderId: order.id,
          segmentId: segment.id,
          scheduleRevision: segment.scheduleRevision,
          ruleVersion,
          milestone: p.milestone,
          dedupeKey: milestoneDedupeKey(companyId, segment.id, segment.scheduleRevision, ruleVersion, p.milestone),
          title: p.milestone === URGENT_MILESTONE ? `Shoshilinch tekshiruv: ${order.orderNo}` : `Reys tekshiruvi ${p.milestone}: ${order.orderNo}`,
          body: reminderText(order.orderNo, contact?.fullName ?? null, segment),
          dueAt: p.dueAt,
          assigneeId,
          escalateAfterMinutes: p.escalateAfterMinutes,
        };
      });
    const res = await tx.reminderOccurrence.createMany({ data, skipDuplicates: true });
    await this.refreshNextReminder(tx, companyId, segment.id);
    return { planned: res.count };
  }

  async refreshNextReminder(tx: Tx, companyId: string, segmentId: string) {
    const next = await tx.reminderOccurrence.findFirst({ where: { companyId, segmentId, state: { in: ['scheduled', 'snoozed'] } }, orderBy: { dueAt: 'asc' }, select: { dueAt: true } });
    await tx.flightSegment.update({ where: { id: segmentId }, data: { nextReminderAt: next?.dueAt ?? null } });
  }

  /** Occurrences of older revisions are superseded and their CRM tasks closed (AC21). */
  async supersedeOldRevisions(tx: Tx, companyId: string, segmentId: string, currentRevision: number) {
    const stale = await tx.reminderOccurrence.findMany({ where: { companyId, segmentId, kind: 'milestone', scheduleRevision: { lt: currentRevision }, state: { in: [...ACTIVE_STATES] } } });
    if (!stale.length) return 0;
    await tx.reminderOccurrence.updateMany({ where: { id: { in: stale.map((s) => s.id) } }, data: { state: 'superseded', cancelReason: 'schedule_revision_changed', leaseUntil: null } });
    await this.closeLinkedTasks(tx, companyId, stale.map((s) => s.id), 'Reys jadvali o‘zgardi; yangi eslatma yaratildi');
    return stale.length;
  }

  async cancelForSegment(tx: Tx, companyId: string, segmentId: string, reason: string) {
    const rows = await tx.reminderOccurrence.findMany({ where: { companyId, segmentId, state: { in: [...ACTIVE_STATES] } } });
    await tx.reminderOccurrence.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { state: 'cancelled', cancelledAt: this.d.clock.now(), cancelReason: reason, leaseUntil: null } });
    await this.closeLinkedTasks(tx, companyId, rows.map((r) => r.id), 'Eslatma bekor qilindi');
    await this.refreshNextReminder(tx, companyId, segmentId);
    return rows.length;
  }

  /** Order cancelled: pending occurrences and their open CRM tasks are cancelled; completed history stays (AC22). */
  async cancelForOrder(actor: Actor, orderId: string, reason: string) {
    await this.d.prisma.$transaction(async (tx) => {
      const rows = await tx.reminderOccurrence.findMany({ where: { companyId: actor.companyId, orderId, state: { in: [...ACTIVE_STATES] } } });
      await tx.reminderOccurrence.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { state: 'cancelled', cancelledAt: this.d.clock.now(), cancelReason: reason, leaseUntil: null } });
      await this.closeLinkedTasks(tx, actor.companyId, rows.map((r) => r.id), 'Buyurtma bekor qilindi');
      await tx.flightSegment.updateMany({ where: { companyId: actor.companyId, orderId }, data: { nextReminderAt: null } });
      await audit(tx, actor, { entityType: 'order', entityId: orderId, action: 'reminders_cancelled', newValue: { count: rows.length, reason } });
    });
  }

  private async closeLinkedTasks(tx: Tx, companyId: string, occurrenceIds: string[], resultText: string) {
    if (!occurrenceIds.length) return;
    const tasks = await tx.crmTask.findMany({ where: { companyId, entityType: 'occurrence', entityId: { in: occurrenceIds }, state: { in: ['pending', 'open'] } } });
    for (const t of tasks) {
      await tx.crmTask.update({ where: { id: t.id }, data: { state: 'cancelled' } });
      await enqueueOutbox(tx, { companyId, operationKey: `task.complete:${t.id}`, target: 'amocrm', action: 'task.complete', payload: { crmTaskId: t.id, result: resultText } });
    }
    await tx.notificationDelivery.updateMany({ where: { companyId, occurrenceId: { in: occurrenceIds }, state: 'pending' }, data: { state: 'cancelled' } });
  }

  // ---------------- Scheduler ----------------

  /** Claims due occurrences with SKIP LOCKED and a lease (worker restart safe, AC25). */
  async claimDue(workerId: string, limit = 50, leaseMs = 120_000): Promise<string[]> {
    const now = this.d.clock.now();
    const rows = await this.d.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE reminder_occurrences SET state = 'dispatching', lease_owner = ${workerId},
             lease_until = ${now}::timestamptz + (${leaseMs}::int * interval '1 millisecond'), attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM reminder_occurrences
        WHERE state IN ('scheduled', 'dispatching', 'snoozed') AND due_at <= ${now}
          AND (lease_until IS NULL OR lease_until < ${now})
        ORDER BY due_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      RETURNING id`;
    return rows.map((r) => r.id);
  }

  /**
   * Dispatches one claimed occurrence. Re-validates revision/order/cancellation first: stale queued
   * work is dropped without side effects (AC21). All side effects use unique keys so a re-run after
   * a crash does not duplicate them (AC25).
   */
  async dispatch(occurrenceId: string): Promise<'dispatched' | 'dropped' | 'skipped'> {
    return this.d.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<ReminderOccurrence[]>`SELECT * FROM reminder_occurrences WHERE id = ${occurrenceId}::uuid FOR UPDATE`;
      if (!locked.length) return 'skipped';
      const occ = await tx.reminderOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } });
      if (occ.state !== 'dispatching') return 'skipped';
      const now = this.d.clock.now();
      const segment = occ.segmentId ? await tx.flightSegment.findUnique({ where: { id: occ.segmentId } }) : null;
      const order = occ.orderId ? await tx.order.findUnique({ where: { id: occ.orderId } }) : null;
      const validity = checkOccurrenceValidity(
        { state: occ.state, scheduleRevision: occ.scheduleRevision, segmentId: occ.segmentId, kind: occ.kind },
        segment ? { scheduleRevision: segment.scheduleRevision, operationalStatus: segment.operationalStatus, active: segment.active, departureAtUtc: segment.departureAtUtc } : null,
        order ? { fulfillmentState: order.fulfillmentState } : null,
        now,
      );
      if (!validity.valid) {
        const state = validity.reason === 'stale_revision' ? 'superseded' : validity.reason === 'departed' ? 'missed' : 'cancelled';
        await tx.reminderOccurrence.update({ where: { id: occ.id }, data: { state, cancelReason: validity.reason, leaseUntil: null, ...(state === 'missed' ? { missedAt: now } : { cancelledAt: now }) } });
        return 'dropped';
      }

      await tx.reminderOccurrence.update({ where: { id: occ.id }, data: { state: 'due', dispatchedAt: now, leaseUntil: null } });
      if (segment && ['pending', 'checked'].includes(segment.checkState)) {
        await tx.flightSegment.update({ where: { id: segment.id }, data: { checkState: 'due' } });
      }
      const link = order ? `/orders/${order.id}` : null;
      if (occ.assigneeId) {
        await notify(tx, { companyId: occ.companyId, userId: occ.assigneeId, kind: 'reminder_due', dedupeKey: `occ:${occ.id}:due`, title: occ.title, body: occ.body, link, occurrenceId: occ.id });
      }
      await tx.notificationDelivery.createMany({
        data: [
          { companyId: occ.companyId, occurrenceId: occ.id, channel: 'in_app', state: occ.assigneeId ? 'sent' : 'failed', lastError: occ.assigneeId ? null : 'no_assignee', attempts: 1 },
          { companyId: occ.companyId, occurrenceId: occ.id, channel: 'amocrm_task', state: 'pending' },
        ],
        skipDuplicates: true,
      });
      if (order) {
        const res = await tx.crmTask.createMany({
          data: [{ companyId: occ.companyId, automationKey: `occ:${occ.id}:task`, entityType: 'occurrence', entityId: occ.id, kind: 'flight_check', text: occ.body ?? occ.title, responsibleUserId: occ.assigneeId, dueAt: segment?.departureAtUtc ?? new Date(now.getTime() + 3600_000), state: 'pending' }],
          skipDuplicates: true,
        });
        if (res.count) {
          const task = await tx.crmTask.findUniqueOrThrow({ where: { companyId_automationKey: { companyId: occ.companyId, automationKey: `occ:${occ.id}:task` } } });
          await enqueueOutbox(tx, { companyId: occ.companyId, operationKey: `task.create:${task.id}`, target: 'amocrm', action: 'task.create', payload: { crmTaskId: task.id, leadId: order.leadId, occurrenceId: occ.id } });
        }
      }
      if (!occ.assigneeId) {
        for (const uid of await headRecipients(tx, occ.companyId)) {
          await notify(tx, { companyId: occ.companyId, userId: uid, kind: 'reminder_unassigned', dedupeKey: `occ:${occ.id}:unassigned:${uid}`, title: `Mas’ulsiz eslatma: ${occ.title}`, link, occurrenceId: occ.id });
        }
      }
      if (occ.kind === 'manual' && occ.seriesId !== null && occ.recurrence) await this.scheduleNextInSeries(tx, occ);
      if (segment) await this.refreshNextReminder(tx, occ.companyId, segment.id);
      await publishEvent(this.d.redis, { companyId: occ.companyId, entityType: 'reminder', entityId: occ.id, ownerId: occ.assigneeId, kind: 'due' });
      return 'dispatched';
    });
  }

  /** Escalation: T-3h after 15 min, others after 60 min; independent of business hours (TZ §14.2). */
  async escalateOverdue(): Promise<number> {
    const now = this.d.clock.now();
    const rows = await this.d.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM reminder_occurrences
      WHERE state = 'due' AND escalated_at IS NULL AND escalate_after_minutes IS NOT NULL
        AND dispatched_at + (escalate_after_minutes * interval '1 minute') <= ${now}
      LIMIT 200`;
    for (const { id } of rows) {
      await this.d.prisma.$transaction(async (tx) => {
        const upd = await tx.reminderOccurrence.updateMany({ where: { id, escalatedAt: null, state: 'due' }, data: { escalatedAt: now } });
        if (upd.count !== 1) return;
        const occ = await tx.reminderOccurrence.findUniqueOrThrow({ where: { id } });
        for (const uid of await headRecipients(tx, occ.companyId)) {
          await notify(tx, { companyId: occ.companyId, userId: uid, kind: 'reminder_escalated', dedupeKey: `occ:${id}:escalated:${uid}`, title: `Eskalatsiya: ${occ.title}`, body: occ.body, link: occ.orderId ? `/orders/${occ.orderId}` : null, occurrenceId: id });
        }
        await audit(tx, systemActor(occ.companyId, 'scheduler'), { entityType: 'reminder', entityId: id, action: 'escalated', newValue: { milestone: occ.milestone } });
      });
    }
    return rows.length;
  }

  /** After departure, unfinished milestone occurrences become `missed` and are never resent. */
  async markMissed(): Promise<number> {
    const now = this.d.clock.now();
    return this.d.prisma.$executeRaw`
      UPDATE reminder_occurrences o SET state = 'missed', missed_at = ${now}, lease_until = NULL, updated_at = now()
      FROM flight_segments s
      WHERE o.segment_id = s.id AND o.kind = 'milestone' AND o.state IN ('scheduled', 'dispatching', 'due', 'snoozed')
        AND s.departure_at_utc IS NOT NULL AND s.departure_at_utc <= ${now}`;
  }

  private async scheduleNextInSeries(tx: Tx, occ: ReminderOccurrence) {
    const recurrence = occ.recurrence as unknown as Recurrence;
    const nextIndex = (occ.seriesIndex ?? 0) + 1;
    const due = nthOccurrence(occ.localStart!, occ.timezone!, recurrence, nextIndex);
    if (!due) return;
    await tx.reminderOccurrence.createMany({
      data: [{ ...seriesFields(occ), seriesIndex: nextIndex, dueAt: due, dedupeKey: `manual:${occ.seriesId}:${nextIndex}` }],
      skipDuplicates: true,
    });
  }

  // ---------------- Manual reminders ----------------

  async createManual(
    actor: UserActor,
    input: { orderId: string; segmentId?: string | null; title: string; body?: string | null; localStart: string; timezone: string; recurrence: Recurrence; assigneeId?: string | null },
  ) {
    try {
      validateRecurrence(input.recurrence);
    } catch (err) {
      throw unprocessable('INVALID_RECURRENCE', (err as Error).message, { recurrence: 'invalid' });
    }
    const firstDue = (() => {
      try {
        return nthOccurrence(input.localStart, input.timezone, input.recurrence, 0);
      } catch {
        return null;
      }
    })();
    if (!firstDue) throw unprocessable('INVALID_START', 'Boshlanish vaqti yoki zona noto‘g‘ri', { localStart: 'invalid' });
    return this.d.prisma.$transaction(async (tx) => {
      const order = assertFound(await tx.order.findFirst({ where: orderWhere(actor, { id: input.orderId }) }), 'Buyurtma');
      if (!canEditRecord(actor, order.ownerId)) throw forbidden();
      if (input.segmentId) assertFound(await tx.flightSegment.findFirst({ where: { id: input.segmentId, orderId: order.id, companyId: actor.companyId } }), 'Segment');
      const assigneeId = input.assigneeId ?? actor.id;
      if (assigneeId !== actor.id) {
        requireCap(actor, 'reminders.assign_others');
        assertFound(await tx.user.findFirst({ where: { id: assigneeId, companyId: actor.companyId, status: 'active' } }), 'Xodim');
      }
      const seriesId = randomUUID();
      const occ = await tx.reminderOccurrence.create({
        data: {
          companyId: actor.companyId,
          kind: 'manual',
          orderId: order.id,
          segmentId: input.segmentId ?? null,
          dedupeKey: `manual:${seriesId}:0`,
          title: input.title,
          body: input.body ?? null,
          dueAt: firstDue,
          assigneeId,
          createdById: actor.id,
          seriesId,
          seriesIndex: 0,
          recurrence: input.recurrence as unknown as Prisma.InputJsonValue,
          localStart: input.localStart,
          timezone: input.timezone,
          escalateAfterMinutes: null,
        },
      });
      await audit(tx, actor, { entityType: 'reminder', entityId: occ.id, action: 'created', newValue: { title: input.title, dueAt: firstDue, recurrence: input.recurrence, assigneeId } });
      return occ;
    });
  }

  private async loadForActor(tx: Tx, actor: UserActor, id: string) {
    const occ = assertFound(await tx.reminderOccurrence.findFirst({ where: { id, companyId: actor.companyId } }), 'Eslatma');
    if (!can(actor.role, 'records.view_all')) {
      const order = occ.orderId ? await tx.order.findFirst({ where: { id: occ.orderId, companyId: actor.companyId }, select: { ownerId: true } }) : null;
      if (occ.assigneeId !== actor.id && order?.ownerId !== actor.id) throw assertFound(null, 'Eslatma');
    }
    return occ;
  }

  async snooze(actor: UserActor, id: string, minutes: number) {
    return this.d.prisma.$transaction(async (tx) => {
      const occ = await this.loadForActor(tx, actor, id);
      if (!['scheduled', 'due', 'snoozed'].includes(occ.state)) throw unprocessable('NOT_ACTIVE', 'Eslatma faol emas');
      let next: Date;
      try {
        next = snoozeUntil(this.d.clock.now(), minutes);
      } catch (err) {
        throw unprocessable('INVALID_SNOOZE', (err as Error).message, { minutes: 'invalid' });
      }
      const updated = await tx.reminderOccurrence.update({ where: { id }, data: { state: 'snoozed', dueAt: next, leaseUntil: null, version: { increment: 1 } } });
      await audit(tx, actor, { entityType: 'reminder', entityId: id, action: 'snoozed', oldValue: { dueAt: occ.dueAt, state: occ.state }, newValue: { dueAt: next } });
      return updated;
    });
  }

  async cancel(actor: UserActor, id: string, reason: string) {
    return this.d.prisma.$transaction(async (tx) => {
      const occ = await this.loadForActor(tx, actor, id);
      if (occ.kind === 'milestone') requireCap(actor, 'records.edit_all');
      if (!(ACTIVE_STATES as readonly string[]).includes(occ.state)) throw unprocessable('NOT_ACTIVE', 'Eslatma faol emas');
      const updated = await tx.reminderOccurrence.update({ where: { id }, data: { state: 'cancelled', cancelledAt: this.d.clock.now(), cancelReason: reason, leaseUntil: null } });
      await this.closeLinkedTasks(tx, actor.companyId, [id], 'Eslatma bekor qilindi');
      await audit(tx, actor, { entityType: 'reminder', entityId: id, action: 'cancelled', newValue: { reason } });
      return updated;
    });
  }

  /**
   * Completes a manual reminder. Milestone reminders are completed only by saving a flight check
   * (closing the amoCRM task never counts as a check, AC23).
   */
  async complete(actor: UserActor, id: string, note: string | null) {
    return this.d.prisma.$transaction(async (tx) => {
      const occ = await this.loadForActor(tx, actor, id);
      if (occ.kind === 'milestone') throw unprocessable('CHECK_RESULT_REQUIRED', 'Natija kiritilishi kerak: reys tekshiruvi natijasini buyurtmada saqlang');
      if (!['due', 'snoozed', 'scheduled'].includes(occ.state)) throw unprocessable('NOT_ACTIVE', 'Eslatma faol emas');
      const updated = await tx.reminderOccurrence.update({ where: { id }, data: { state: 'completed', completedAt: this.d.clock.now(), completedById: actor.id, resultNote: note } });
      await this.closeLinkedTasks(tx, actor.companyId, [id], note ?? 'Bajarildi');
      await audit(tx, actor, { entityType: 'reminder', entityId: id, action: 'completed', newValue: { note } });
      return updated;
    });
  }

  async list(actor: UserActor, q: { state?: string; limit: number; cursor?: string }) {
    const scope = can(actor.role, 'records.view_all')
      ? {}
      : { OR: [{ assigneeId: actor.id }, { orderId: { in: (await this.d.prisma.order.findMany({ where: { companyId: actor.companyId, ownerId: actor.id }, select: { id: true } })).map((o) => o.id) } }] };
    const rows = await this.d.prisma.reminderOccurrence.findMany({
      where: { companyId: actor.companyId, ...(q.state ? { state: q.state as ReminderOccurrence['state'] } : { state: { in: [...ACTIVE_STATES] } }), ...scope },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit);
    return { items, nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null };
  }

  // ---------------- Rules (admin) ----------------

  /** Rules are versioned; a change replans only future occurrences of the affected milestone. */
  async updateRule(actor: UserActor, milestone: string, patch: { offsetSeconds?: number; enabled?: boolean; escalateAfterMinutes?: number }) {
    requireCap(actor, 'integrations.manage');
    const changed = await this.d.prisma.$transaction(async (tx) => {
      const current = assertFound(await tx.reminderRule.findFirst({ where: { companyId: actor.companyId, milestone, current: true } }), 'Qoida');
      await tx.reminderRule.update({ where: { id: current.id }, data: { current: false } });
      const next = await tx.reminderRule.create({
        data: {
          companyId: actor.companyId,
          milestone,
          offsetSeconds: patch.offsetSeconds ?? current.offsetSeconds,
          enabled: patch.enabled ?? current.enabled,
          escalateAfterMinutes: patch.escalateAfterMinutes ?? current.escalateAfterMinutes,
          version: current.version + 1,
          current: true,
        },
      });
      const future = await tx.reminderOccurrence.findMany({ where: { companyId: actor.companyId, kind: 'milestone', milestone, state: 'scheduled', dueAt: { gt: this.d.clock.now() } }, select: { id: true, segmentId: true } });
      await tx.reminderOccurrence.updateMany({ where: { id: { in: future.map((f) => f.id) } }, data: { state: 'superseded', cancelReason: 'rule_changed' } });
      await audit(tx, actor, { entityType: 'reminder_rule', entityId: next.id, action: 'updated', oldValue: current, newValue: next });
      return [...new Set(future.map((f) => f.segmentId).filter((s): s is string => !!s))];
    });
    for (const segmentId of changed) await this.d.prisma.$transaction((tx) => this.planForSegment(tx, actor.companyId, segmentId, { allowUrgent: false }));
    return { replannedSegments: changed.length };
  }
}

function seriesFields(o: ReminderOccurrence) {
  return {
    companyId: o.companyId,
    kind: o.kind,
    orderId: o.orderId,
    segmentId: o.segmentId,
    title: o.title,
    body: o.body,
    assigneeId: o.assigneeId,
    createdById: o.createdById,
    seriesId: o.seriesId,
    recurrence: o.recurrence as Prisma.InputJsonValue,
    localStart: o.localStart,
    timezone: o.timezone,
    escalateAfterMinutes: o.escalateAfterMinutes,
  };
}

export function reminderText(
  orderNo: string,
  customer: string | null,
  s: { originIata: string; destinationIata: string; marketingCarrier: string; flightNumber: string; departureAtUtc: Date | null; departureTimezone: string },
): string {
  const when = s.departureAtUtc ? formatAirportTimeUz(s.departureAtUtc, s.departureTimezone) : 'vaqti kiritilmagan';
  return `Diqqat. ${orderNo} buyurtmasi bo‘yicha uchish yaqinlashmoqda. Mijoz: ${customer ?? '—'}. ${s.originIata}–${s.destinationIata}, ${s.marketingCarrier} ${s.flightNumber}, ${when}. Reys holati, uchish vaqti va aeroport ma’lumotlarini tekshiring. Natijani buyurtmada qayd eting.`;
}
