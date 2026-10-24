import type { FlightSegment, Prisma, Tx } from '@crm/database';
import { can, localToUtc, maskReference, revisionChanged, utcToLocal } from '@crm/domain';
import { audit } from '../audit';
import type { CoreDeps, UserActor } from '../context';
import { notify, publishEvent } from '../events';
import { conflict, forbidden, unprocessable } from '../errors';
import { assertFound, canEditRecord, orderWhere } from '../scope';
import { RemindersService } from './reminders.service';

export interface LocalTimeInput {
  local: string;
  timezone: string;
  /** Required only when the local time is ambiguous (DST fall-back). */
  confirmedOffsetMinutes?: number | null;
}

export interface SegmentInput {
  direction: 'outbound' | 'connection' | 'return';
  originIata: string;
  destinationIata: string;
  originAirportName?: string | null;
  destinationAirportName?: string | null;
  marketingCarrier: string;
  operatingCarrier?: string | null;
  flightNumber: string;
  departure: LocalTimeInput | null;
  departureTimezone: string;
  arrival: LocalTimeInput | null;
  arrivalTimezone: string;
  pnr?: string | null;
  bookingProvider?: string | null;
  passengerIds?: string[];
}

function resolveTime(field: string, t: LocalTimeInput | null): Date | null {
  if (!t) return null;
  const r = localToUtc(t.local, t.timezone, t.confirmedOffsetMinutes);
  if (r.kind === 'ok') return r.utc;
  if (r.kind === 'ambiguous') {
    throw unprocessable('AMBIGUOUS_LOCAL_TIME', 'Bu mahalliy vaqt ikki marta uchraydi (DST). UTC offsetni tasdiqlang.', { [field]: 'ambiguous' }, {
      field,
      options: r.options.map((o) => ({ utc: o.utc.toISOString(), offsetMinutes: o.offsetMinutes })),
    });
  }
  if (r.kind === 'nonexistent') throw unprocessable('NONEXISTENT_LOCAL_TIME', 'Bu mahalliy vaqt DST o‘tishi sababli mavjud emas', { [field]: 'nonexistent' });
  throw unprocessable('INVALID_TIME', r.reason === 'bad_zone' ? 'IANA vaqt zonasi noto‘g‘ri (masalan, Asia/Dubai)' : 'Vaqt formati noto‘g‘ri', { [field]: r.reason });
}

const IATA = /^[A-Z]{3}$/;

export function serializeSegment(s: FlightSegment, canSeeFull: boolean) {
  return {
    ...s,
    pnr: canSeeFull ? s.pnr : maskReference(s.pnr),
    departureLocal: s.departureAtUtc ? utcToLocal(s.departureAtUtc, s.departureTimezone).local : null,
    arrivalLocal: s.arrivalAtUtc ? utcToLocal(s.arrivalAtUtc, s.arrivalTimezone).local : null,
    dataSource: s.evidenceSource ?? 'manual',
    liveData: false,
  };
}

export class SegmentsService {
  private readonly reminders: RemindersService;
  constructor(private readonly d: CoreDeps) {
    this.reminders = new RemindersService(d);
  }

  private validate(input: Partial<SegmentInput>) {
    const errors: Record<string, string> = {};
    if (input.originIata !== undefined && !IATA.test(input.originIata)) errors.originIata = 'iata';
    if (input.destinationIata !== undefined && !IATA.test(input.destinationIata)) errors.destinationIata = 'iata';
    if (Object.keys(errors).length) throw unprocessable('VALIDATION_FAILED', 'Aeroport IATA kodi 3 ta lotin harfi bo‘lishi kerak', errors);
  }

  async addSegment(actor: UserActor, orderId: string, input: SegmentInput) {
    this.validate(input);
    if (input.departure && input.departure.timezone !== input.departureTimezone) throw unprocessable('VALIDATION_FAILED', 'Jo‘nash zonasi mos emas', { departureTimezone: 'mismatch' });
    if (input.arrival && input.arrival.timezone !== input.arrivalTimezone) throw unprocessable('VALIDATION_FAILED', 'Yetib kelish zonasi mos emas', { arrivalTimezone: 'mismatch' });
    const departureAtUtc = resolveTime('departure', input.departure);
    const arrivalAtUtc = resolveTime('arrival', input.arrival);
    resolveTime('departureTimezone', { local: '2000-01-01T00:00', timezone: input.departureTimezone });
    resolveTime('arrivalTimezone', { local: '2000-01-01T00:00', timezone: input.arrivalTimezone });
    if (departureAtUtc && arrivalAtUtc && arrivalAtUtc <= departureAtUtc) throw unprocessable('VALIDATION_FAILED', 'Yetib kelish jo‘nashdan keyin bo‘lishi kerak', { arrival: 'before_departure' });

    const seg = await this.d.prisma.$transaction(async (tx) => {
      const order = assertFound(await tx.order.findFirst({ where: orderWhere(actor, { id: orderId }) }), 'Buyurtma');
      if (!canEditRecord(actor, order.ownerId)) throw forbidden();
      if (order.fulfillmentState === 'cancelled') throw unprocessable('ORDER_CANCELLED', 'Bekor qilingan buyurtma');
      await tx.$executeRaw`SELECT 1 FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      const max = await tx.flightSegment.aggregate({ where: { companyId: actor.companyId, orderId }, _max: { segmentNo: true } });
      const segment = await tx.flightSegment.create({
        data: {
          companyId: actor.companyId,
          orderId,
          segmentNo: (max._max.segmentNo ?? 0) + 1,
          direction: input.direction,
          originIata: input.originIata,
          destinationIata: input.destinationIata,
          originAirportName: input.originAirportName ?? null,
          destinationAirportName: input.destinationAirportName ?? null,
          marketingCarrier: input.marketingCarrier,
          operatingCarrier: input.operatingCarrier ?? null,
          flightNumber: input.flightNumber,
          departureAtUtc,
          departureTimezone: input.departureTimezone,
          departureLocalOriginal: input.departure?.local ?? null,
          arrivalAtUtc,
          arrivalTimezone: input.arrivalTimezone,
          arrivalLocalOriginal: input.arrival?.local ?? null,
          pnr: input.pnr ?? null,
          bookingProvider: input.bookingProvider ?? null,
          ownerId: order.ownerId,
          evidenceSource: 'manual',
        },
      });
      await this.linkPassengers(tx, actor.companyId, orderId, segment.id, input.passengerIds ?? []);
      await tx.segmentRevision.create({ data: { companyId: actor.companyId, segmentId: segment.id, revision: 1, before: {}, after: revisionSnapshot(segment), changedById: actor.id } });
      await audit(tx, actor, { entityType: 'segment', entityId: segment.id, action: 'created', newValue: revisionSnapshot(segment) });
      await this.reminders.planForSegment(tx, actor.companyId, segment.id);
      return segment;
    });
    await publishEvent(this.d.redis, { companyId: actor.companyId, entityType: 'segment', entityId: seg.id, ownerId: seg.ownerId, kind: 'created' });
    return seg;
  }

  private async linkPassengers(tx: Tx, companyId: string, orderId: string, segmentId: string, passengerIds: string[]) {
    if (!passengerIds.length) return;
    const ps = await tx.passenger.findMany({ where: { id: { in: passengerIds }, companyId, orderId }, select: { id: true } });
    if (ps.length !== passengerIds.length) throw unprocessable('PASSENGER_INVALID', 'Yo‘lovchi buyurtmaga tegishli emas');
    await tx.segmentPassenger.createMany({ data: ps.map((p) => ({ companyId, segmentId, passengerId: p.id })), skipDuplicates: true });
  }

  /**
   * Schedule changes bump schedule_revision, make previous checks stale and replan future reminders
   * (TZ §13.4, AC21). Cancellation stops regular reminders and opens a customer-contact task (AC22).
   */
  async updateSegment(
    actor: UserActor,
    id: string,
    version: number,
    patch: Partial<Omit<SegmentInput, 'passengerIds'>> & { operationalStatus?: 'scheduled' | 'schedule_changed' | 'cancelled'; active?: boolean; passengerIds?: string[] },
    opts: { tx?: Tx; reason?: string } = {},
  ) {
    this.validate(patch);
    const run = async (tx: Tx) => {
      const seg = assertFound(await tx.flightSegment.findFirst({ where: { id, companyId: actor.companyId } }), 'Segment');
      const order = assertFound(await tx.order.findFirst({ where: orderWhere(actor, { id: seg.orderId }) }), 'Segment');
      if (!canEditRecord(actor, order.ownerId)) throw forbidden();
      if (seg.version !== version) throw conflict('VERSION_CONFLICT', 'Segment boshqa foydalanuvchi tomonidan o‘zgartirilgan. Sahifani yangilang.');

      const departureTimezone = patch.departureTimezone ?? seg.departureTimezone;
      const arrivalTimezone = patch.arrivalTimezone ?? seg.arrivalTimezone;
      const next: Prisma.FlightSegmentUncheckedUpdateInput = { version: { increment: 1 } };
      const after: Record<string, unknown> = {};
      const set = (k: keyof FlightSegment, v: unknown) => {
        (next as Record<string, unknown>)[k] = v;
        after[k] = v;
      };
      if (patch.departure !== undefined) {
        set('departureAtUtc', resolveTime('departure', patch.departure ? { ...patch.departure, timezone: departureTimezone } : null));
        set('departureLocalOriginal', patch.departure?.local ?? null);
      }
      if (patch.arrival !== undefined) {
        set('arrivalAtUtc', resolveTime('arrival', patch.arrival ? { ...patch.arrival, timezone: arrivalTimezone } : null));
        set('arrivalLocalOriginal', patch.arrival?.local ?? null);
      }
      for (const k of ['originIata', 'destinationIata', 'originAirportName', 'destinationAirportName', 'marketingCarrier', 'operatingCarrier', 'flightNumber', 'pnr', 'bookingProvider', 'direction', 'departureTimezone', 'arrivalTimezone', 'active'] as const) {
        if (patch[k] !== undefined) set(k, patch[k]);
      }
      if (patch.operationalStatus) set('operationalStatus', patch.operationalStatus);

      const bump = revisionChanged(seg as unknown as Record<string, unknown>, after);
      const newRevision = bump ? seg.scheduleRevision + 1 : seg.scheduleRevision;
      if (bump) {
        next.scheduleRevision = newRevision;
        if (!patch.operationalStatus && seg.operationalStatus === 'scheduled') next.operationalStatus = 'schedule_changed';
        if (['checked', 'due', 'in_progress'].includes(seg.checkState)) next.checkState = 'recheck_required';
      }
      await tx.flightSegment.update({ where: { id }, data: next });
      if (patch.passengerIds) {
        await tx.segmentPassenger.deleteMany({ where: { segmentId: id } });
        await this.linkPassengers(tx, actor.companyId, seg.orderId, id, patch.passengerIds);
      }
      const updated = await tx.flightSegment.findUniqueOrThrow({ where: { id } });
      if (bump) {
        await tx.segmentRevision.create({ data: { companyId: actor.companyId, segmentId: id, revision: newRevision, before: revisionSnapshot(seg), after: revisionSnapshot(updated), changedById: actor.id } });
        await this.reminders.supersedeOldRevisions(tx, actor.companyId, id, newRevision);
      }
      await audit(tx, actor, {
        entityType: 'segment',
        entityId: id,
        action: bump ? 'revision_changed' : patch.operationalStatus === 'cancelled' ? 'cancelled' : 'updated',
        oldValue: revisionSnapshot(seg),
        newValue: { ...revisionSnapshot(updated), reason: opts.reason ?? null },
      });

      if (updated.operationalStatus === 'cancelled' || updated.active === false) {
        await this.reminders.cancelForSegment(tx, actor.companyId, id, updated.operationalStatus === 'cancelled' ? 'segment_cancelled' : 'segment_inactive');
        if (updated.operationalStatus === 'cancelled' && seg.operationalStatus !== 'cancelled') {
          await tx.flightSegment.update({ where: { id }, data: { notificationState: 'required' } });
          const { LeadsService } = await import('./leads.service');
          await new LeadsService(this.d).createCrmTask(tx, {
            companyId: actor.companyId,
            key: `segment:${id}:cancelled`,
            entityId: order.leadId,
            kind: 'contact_customer',
            text: `Reys bekor qilindi: ${order.orderNo}, ${updated.marketingCarrier} ${updated.flightNumber}. Mijoz bilan bog‘laning.`,
            responsibleUserId: updated.ownerId,
            dueAt: new Date(this.d.clock.now().getTime() + 30 * 60_000),
          });
          if (updated.ownerId) {
            await notify(tx, { companyId: actor.companyId, userId: updated.ownerId, kind: 'segment_cancelled', dedupeKey: `segment_cancelled:${id}`, title: `Reys bekor qilindi: ${order.orderNo}`, link: `/orders/${order.id}` });
          }
        }
      } else if (bump) {
        await this.reminders.planForSegment(tx, actor.companyId, id);
      }
      return updated;
    };
    const updated = opts.tx ? await run(opts.tx) : await this.d.prisma.$transaction(run);
    await publishEvent(this.d.redis, { companyId: actor.companyId, entityType: 'segment', entityId: id, ownerId: updated.ownerId, kind: 'updated' });
    return updated;
  }

  // ---------------- Manual flight checks (TZ §13.4) ----------------

  async startCheck(actor: UserActor, segmentId: string) {
    return this.d.prisma.$transaction(async (tx) => {
      const seg = await this.loadEditable(tx, actor, segmentId);
      const updated = await tx.flightSegment.update({ where: { id: seg.id }, data: { checkState: 'in_progress', version: { increment: 1 } } });
      await audit(tx, actor, { entityType: 'segment', entityId: seg.id, action: 'check_started', newValue: { revision: seg.scheduleRevision } });
      return updated;
    });
  }

  /**
   * Saves a manual check result. It is bound to the current revision and to the occurrence that is
   * currently due; it completes only that occurrence (a T-168h check never completes T-24h, AC20)
   * and closes the linked amoCRM task.
   */
  async saveCheck(
    actor: UserActor,
    segmentId: string,
    input: { result: 'confirmed' | 'changed' | 'cancelled'; observedDeparture?: LocalTimeInput | null; terminal?: string | null; note?: string | null; customerNotificationNeeded: boolean; occurrenceId?: string | null },
  ) {
    const out = await this.d.prisma.$transaction(async (tx) => {
      const seg = await this.loadEditable(tx, actor, segmentId);
      const now = this.d.clock.now();
      const observed = input.observedDeparture ? resolveTime('observedDeparture', input.observedDeparture) : null;
      if (input.result === 'changed' && !observed) throw unprocessable('VALIDATION_FAILED', 'O‘zgargan jo‘nash vaqtini kiriting', { observedDeparture: 'required' });

      const dueOccs = await tx.reminderOccurrence.findMany({
        where: { companyId: actor.companyId, segmentId, kind: 'milestone', scheduleRevision: seg.scheduleRevision, state: 'due', ...(input.occurrenceId ? { id: input.occurrenceId } : {}) },
        orderBy: { dueAt: 'desc' },
      });
      const target = dueOccs[0] ?? null;
      const check = await tx.flightCheck.create({
        data: {
          companyId: actor.companyId,
          segmentId,
          scheduleRevision: seg.scheduleRevision,
          milestone: target?.milestone ?? null,
          occurrenceId: target?.id ?? null,
          result: input.result,
          observedDepartureAtUtc: observed,
          terminal: input.terminal ?? null,
          source: 'manual',
          change: input.result === 'changed' ? ({ departureAtUtc: { from: seg.departureAtUtc?.toISOString() ?? null, to: observed!.toISOString() } } as Prisma.InputJsonValue) : undefined,
          note: input.note ?? null,
          customerNotificationNeeded: input.customerNotificationNeeded,
          checkedAt: now,
          checkedById: actor.id,
        },
      });
      if (target) {
        await tx.reminderOccurrence.update({ where: { id: target.id }, data: { state: 'completed', completedAt: now, completedById: actor.id, flightCheckId: check.id } });
        const task = await tx.crmTask.findFirst({ where: { companyId: actor.companyId, entityType: 'occurrence', entityId: target.id } });
        if (task && ['pending', 'open'].includes(task.state)) {
          await tx.crmTask.update({ where: { id: task.id }, data: { state: 'completed' } });
          const { enqueueOutbox } = await import('../queue');
          await enqueueOutbox(tx, { companyId: actor.companyId, operationKey: `task.complete:${task.id}`, target: 'amocrm', action: 'task.complete', payload: { crmTaskId: task.id, result: `Reys tekshirildi: ${input.result}` } });
        }
        await tx.notificationDelivery.updateMany({ where: { occurrenceId: target.id, channel: 'amocrm_task' }, data: { state: 'completed' } });
      }
      await tx.flightSegment.update({
        where: { id: segmentId },
        data: {
          checkState: 'checked',
          lastCheckedAt: now,
          checkedById: actor.id,
          evidenceSource: 'manual',
          notificationState: input.customerNotificationNeeded ? 'required' : seg.notificationState,
          ...(input.terminal ? {} : {}),
          version: { increment: 1 },
        },
      });
      await audit(tx, actor, { entityType: 'segment', entityId: segmentId, action: 'checked', newValue: { checkId: check.id, result: input.result, revision: seg.scheduleRevision, milestone: target?.milestone ?? null } });
      return { check, seg: await tx.flightSegment.findUniqueOrThrow({ where: { id: segmentId } }) };
    });

    if (input.result === 'changed' && input.observedDeparture) {
      await this.updateSegment(actor, segmentId, out.seg.version, { departure: input.observedDeparture, departureTimezone: input.observedDeparture.timezone, operationalStatus: 'schedule_changed' }, { reason: `check:${out.check.id}` });
      // The person who observed the new time has verified it.
      await this.d.prisma.flightSegment.update({ where: { id: segmentId }, data: { checkState: 'checked' } });
    } else if (input.result === 'cancelled') {
      await this.updateSegment(actor, segmentId, out.seg.version, { operationalStatus: 'cancelled' }, { reason: `check:${out.check.id}` });
    }
    await publishEvent(this.d.redis, { companyId: actor.companyId, entityType: 'segment', entityId: segmentId, ownerId: out.seg.ownerId, kind: 'checked' });
    return out.check;
  }

  /** "Mijoz xabardor qilindi" requires channel, time, author and result (TZ §13.3). */
  async recordCustomerNotification(actor: UserActor, segmentId: string, input: { channel: string; result: string; note?: string | null; at?: Date }) {
    return this.d.prisma.$transaction(async (tx) => {
      const seg = await this.loadEditable(tx, actor, segmentId);
      const n = await tx.customerNotification.create({ data: { companyId: actor.companyId, segmentId, channel: input.channel, result: input.result, note: input.note ?? null, authorId: actor.id, at: input.at ?? this.d.clock.now() } });
      await tx.flightSegment.update({ where: { id: seg.id }, data: { notificationState: 'notified', version: { increment: 1 } } });
      await audit(tx, actor, { entityType: 'segment', entityId: segmentId, action: 'customer_notified', newValue: { channel: input.channel, result: input.result } });
      return n;
    });
  }

  private async loadEditable(tx: Tx, actor: UserActor, segmentId: string) {
    const seg = assertFound(await tx.flightSegment.findFirst({ where: { id: segmentId, companyId: actor.companyId } }), 'Segment');
    const order = assertFound(await tx.order.findFirst({ where: orderWhere(actor, { id: seg.orderId }) }), 'Segment');
    if (!canEditRecord(actor, order.ownerId)) throw forbidden();
    return seg;
  }

  // ---------------- Flights dashboard (TZ §15.3) ----------------

  async flightsBoard(actor: UserActor, q: { filter?: 'today' | '24h' | '7d' | 'overdue' | 'changed'; limit: number; cursor?: string }) {
    const now = this.d.clock.now();
    const where: Prisma.FlightSegmentWhereInput = { companyId: actor.companyId, active: true, departureAtUtc: { gte: new Date(now.getTime() - 6 * 3600_000) } };
    if (!can(actor.role, 'records.view_all')) where.ownerId = actor.id;
    const dep = (ms: number) => ({ gte: now, lt: new Date(now.getTime() + ms) });
    if (q.filter === 'today') {
      const { DateTime } = await import('luxon');
      const end = DateTime.fromJSDate(now, { zone: 'Asia/Tashkent' }).endOf('day').toJSDate();
      where.departureAtUtc = { gte: now, lte: end };
    }
    if (q.filter === '24h') where.departureAtUtc = dep(24 * 3600_000);
    if (q.filter === '7d') where.departureAtUtc = dep(7 * 24 * 3600_000);
    if (q.filter === 'changed') where.operationalStatus = 'schedule_changed';
    if (q.filter === 'overdue') {
      const overdue = await this.d.prisma.reminderOccurrence.findMany({ where: { companyId: actor.companyId, state: 'due', kind: 'milestone', dispatchedAt: { lt: new Date(now.getTime() - 15 * 60_000) } }, select: { segmentId: true } });
      where.id = { in: overdue.map((o) => o.segmentId!).filter(Boolean) };
    }
    const rows = await this.d.prisma.flightSegment.findMany({
      where,
      orderBy: [{ departureAtUtc: 'asc' }, { id: 'asc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { order: { select: { id: true, orderNo: true, contactId: true, ownerId: true } } },
    });
    const items = rows.slice(0, q.limit);
    const contacts = await this.d.prisma.contact.findMany({ where: { id: { in: items.map((i) => i.order.contactId) } }, select: { id: true, fullName: true } });
    const owners = await this.d.prisma.user.findMany({ where: { id: { in: items.map((i) => i.ownerId).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } });
    const canFull = can(actor.role, 'reference.view_full');
    return {
      items: items.map((s) => ({
        ...serializeSegment(s, canFull || s.ownerId === actor.id),
        orderNo: s.order.orderNo,
        orderId: s.order.id,
        customer: contacts.find((c) => c.id === s.order.contactId)?.fullName ?? null,
        ownerName: owners.find((o) => o.id === s.ownerId)?.fullName ?? null,
      })),
      nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null,
      generatedAt: now.toISOString(),
    };
  }
}

function revisionSnapshot(s: FlightSegment) {
  return {
    revision: s.scheduleRevision,
    originIata: s.originIata,
    destinationIata: s.destinationIata,
    marketingCarrier: s.marketingCarrier,
    flightNumber: s.flightNumber,
    departureAtUtc: s.departureAtUtc?.toISOString() ?? null,
    departureTimezone: s.departureTimezone,
    arrivalAtUtc: s.arrivalAtUtc?.toISOString() ?? null,
    arrivalTimezone: s.arrivalTimezone,
    operationalStatus: s.operationalStatus,
  };
}
