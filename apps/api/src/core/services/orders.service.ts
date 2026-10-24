import type { FulfillmentState, Order, PaymentState, Prisma, TicketingState, Tx } from '@crm/database';
import { formatMoney, formatOrderNo, isSupportedCurrency, parseMoney, sumByCurrency } from '@crm/domain';
import { audit } from '../audit';
import type { CoreDeps, UserActor } from '../context';
import { publishEvent } from '../events';
import { conflict, forbidden, isPgUniqueViolation, unprocessable } from '../errors';
import { enqueueOutbox } from '../queue';
import { assertFound, canEditRecord, leadWhere, orderWhere } from '../scope';

/** Atomic per-company, per-year order number; gaps are acceptable (TZ §12.3). */
export async function nextOrderNo(tx: Tx, companyId: string, year: number): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ last_value: number }>>`
    INSERT INTO order_sequences (company_id, year, last_value) VALUES (${companyId}::uuid, ${year}, 1)
    ON CONFLICT (company_id, year) DO UPDATE SET last_value = order_sequences.last_value + 1
    RETURNING last_value`;
  const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { orderPrefix: true } });
  return formatOrderNo(company.orderPrefix, year, rows[0]!.last_value);
}

/**
 * Inserts an order honoring "one active order per lead" (partial unique index). If another
 * transaction won the race, the existing active order is returned instead (idempotent).
 */
export async function createOrderRow(
  tx: Tx,
  p: { companyId: string; leadId: string; contactId: string; ownerId: string | null; now: Date; fulfillmentState: FulfillmentState; agreedAmountMinor?: bigint | null; currency?: string | null; offerVersionId?: string | null; note?: string | null },
): Promise<Order> {
  const existing = await tx.order.findFirst({ where: { companyId: p.companyId, leadId: p.leadId, fulfillmentState: { not: 'cancelled' } } });
  if (existing) return existing;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order:${p.leadId}`}, 0))`;
  const again = await tx.order.findFirst({ where: { companyId: p.companyId, leadId: p.leadId, fulfillmentState: { not: 'cancelled' } } });
  if (again) return again;
  const orderNo = await nextOrderNo(tx, p.companyId, p.now.getUTCFullYear());
  const order = await tx.order.create({
    data: {
      companyId: p.companyId,
      orderNo,
      leadId: p.leadId,
      contactId: p.contactId,
      ownerId: p.ownerId,
      fulfillmentState: p.fulfillmentState,
      agreedAmountMinor: p.agreedAmountMinor ?? null,
      currency: p.currency ?? null,
      offerVersionId: p.offerVersionId ?? null,
      note: p.note ?? null,
    },
  });
  await enqueueOutbox(tx, { companyId: p.companyId, operationKey: `order.summary:${order.id}:1`, target: 'amocrm', action: 'order.summary', payload: { orderId: order.id, leadId: p.leadId } });
  return order;
}

export function serializeOrder(o: Order) {
  return {
    ...o,
    agreedAmount: o.agreedAmountMinor !== null && o.currency ? formatMoney({ amountMinor: o.agreedAmountMinor, currency: o.currency }) : null,
    agreedAmountMinor: undefined,
  };
}

export class OrdersService {
  constructor(private readonly d: CoreDeps) {}

  // ---------- Offers ----------

  async createOffer(actor: UserActor, leadId: string, input: { content: string; amount: string; currency: string; validUntil: Date | null; options?: unknown[]; includedServices?: unknown[]; note?: string | null }) {
    if (!isSupportedCurrency(input.currency)) throw unprocessable('INVALID_CURRENCY', 'Valyuta qo‘llab-quvvatlanmaydi', { currency: 'unsupported' });
    const money = parseMoney(input.amount, input.currency);
    if (money.amountMinor < 0n) throw unprocessable('INVALID_AMOUNT', 'Summa manfiy bo‘lmasin', { amount: 'negative' });
    return this.d.prisma.$transaction(async (tx) => {
      const lead = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id: leadId }) }), 'Lid');
      if (!canEditRecord(actor, lead.ownerId)) throw forbidden();
      await tx.$executeRaw`SELECT 1 FROM leads WHERE id = ${leadId}::uuid FOR UPDATE`;
      const last = await tx.offer.findFirst({ where: { companyId: actor.companyId, leadId }, orderBy: { version: 'desc' } });
      const version = (last?.version ?? 0) + 1;
      const offer = await tx.offer.create({
        data: {
          companyId: actor.companyId,
          leadId,
          offerNo: last?.offerNo ?? `OF-${lead.id.slice(0, 8).toUpperCase()}`,
          version,
          content: input.content,
          options: (input.options ?? []) as Prisma.InputJsonValue,
          includedServices: (input.includedServices ?? []) as Prisma.InputJsonValue,
          amountMinor: money.amountMinor,
          currency: money.currency,
          validUntil: input.validUntil,
          note: input.note ?? null,
          createdById: actor.id,
        },
      });
      await audit(tx, actor, { entityType: 'offer', entityId: offer.id, action: 'created', newValue: { leadId, version, amount: input.amount, currency: input.currency } });
      return offer;
    });
  }

  /** Marks a version as sent; sent versions are immutable (a change creates a new version). */
  async markOfferSent(actor: UserActor, offerId: string, channel: string) {
    return this.d.prisma.$transaction(async (tx) => {
      const offer = assertFound(await tx.offer.findFirst({ where: { id: offerId, companyId: actor.companyId } }), 'Taklif');
      const lead = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id: offer.leadId }) }), 'Taklif');
      if (!canEditRecord(actor, lead.ownerId)) throw forbidden();
      if (offer.sentAt) throw conflict('OFFER_ALREADY_SENT', 'Bu versiya allaqachon yuborilgan; o‘zgartirish uchun yangi versiya yarating');
      const updated = await tx.offer.update({ where: { id: offerId }, data: { sentAt: this.d.clock.now(), sentChannel: channel } });
      await audit(tx, actor, { entityType: 'offer', entityId: offerId, action: 'sent', newValue: { channel } });
      return updated;
    });
  }

  async acceptOffer(actor: UserActor, offerId: string) {
    return this.d.prisma.$transaction(async (tx) => {
      const offer = assertFound(await tx.offer.findFirst({ where: { id: offerId, companyId: actor.companyId } }), 'Taklif');
      const lead = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id: offer.leadId }) }), 'Taklif');
      if (!canEditRecord(actor, lead.ownerId)) throw forbidden();
      if (!offer.sentAt) throw unprocessable('OFFER_NOT_SENT', 'Avval taklif mijozga yuborilgan bo‘lishi kerak');
      const updated = await tx.offer.update({ where: { id: offerId }, data: { acceptedAt: this.d.clock.now() } });
      await audit(tx, actor, { entityType: 'offer', entityId: offerId, action: 'accepted' });
      return updated;
    });
  }

  // ---------- Orders ----------

  async createOrder(actor: UserActor, input: { leadId: string; offerVersionId?: string | null; agreedAmount?: string | null; currency?: string | null; note?: string | null }) {
    return this.d.prisma.$transaction(async (tx) => {
      const lead = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id: input.leadId }) }), 'Lid');
      if (!canEditRecord(actor, lead.ownerId)) throw forbidden();
      const existing = await tx.order.findFirst({ where: { companyId: actor.companyId, leadId: lead.id, fulfillmentState: { not: 'cancelled' } } });
      if (existing) throw conflict('ORDER_EXISTS', 'Bu lid uchun faol buyurtma mavjud', { orderId: existing.id, orderNo: existing.orderNo });
      let amountMinor: bigint | null = null;
      let currency: string | null = null;
      let offerVersionId: string | null = null;
      if (input.offerVersionId) {
        const offer = assertFound(await tx.offer.findFirst({ where: { id: input.offerVersionId, companyId: actor.companyId, leadId: lead.id } }), 'Taklif');
        amountMinor = offer.amountMinor;
        currency = offer.currency;
        offerVersionId = offer.id;
      }
      if (input.agreedAmount && input.currency) {
        if (!isSupportedCurrency(input.currency)) throw unprocessable('INVALID_CURRENCY', 'Valyuta qo‘llab-quvvatlanmaydi', { currency: 'unsupported' });
        const m = parseMoney(input.agreedAmount, input.currency);
        amountMinor = m.amountMinor;
        currency = m.currency;
      }
      try {
        const order = await createOrderRow(tx, { companyId: actor.companyId, leadId: lead.id, contactId: lead.contactId, ownerId: lead.ownerId, now: this.d.clock.now(), fulfillmentState: 'draft', agreedAmountMinor: amountMinor, currency, offerVersionId, note: input.note ?? null });
        await audit(tx, actor, { entityType: 'order', entityId: order.id, action: 'created', newValue: { orderNo: order.orderNo, leadId: lead.id } });
        return order;
      } catch (err) {
        if (isPgUniqueViolation(err)) throw conflict('ORDER_EXISTS', 'Bu lid uchun faol buyurtma mavjud');
        throw err;
      }
    });
  }

  async getOrder(actor: UserActor, id: string) {
    const order = assertFound(
      await this.d.prisma.order.findFirst({
        where: orderWhere(actor, { id }),
        include: {
          services: true,
          passengers: { include: { segments: true, tickets: { include: { segments: true } } } },
          segments: { orderBy: { segmentNo: 'asc' }, include: { passengers: true, checks: { orderBy: { checkedAt: 'desc' }, take: 20 } } },
          payments: { orderBy: { receivedAt: 'asc' } },
        },
      }),
      'Buyurtma',
    );
    const canSeeFull = actor.role !== 'MANAGER' || order.ownerId === actor.id;
    const [lead, contact, reminders, auditRows] = await Promise.all([
      this.d.prisma.lead.findFirst({ where: { id: order.leadId, companyId: actor.companyId }, select: { id: true, name: true, stage: true, amoLeadId: true } }),
      this.d.prisma.contact.findFirst({ where: { id: order.contactId, companyId: actor.companyId }, select: { id: true, fullName: true, primaryPhone: true, primaryEmail: true } }),
      this.d.prisma.reminderOccurrence.findMany({ where: { companyId: actor.companyId, orderId: id }, orderBy: { dueAt: 'asc' } }),
      this.d.prisma.auditLog.findMany({ where: { companyId: actor.companyId, entityId: { in: [id, ...order.segments.map((s) => s.id)] } }, orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);
    return { order, lead, contact, reminders, audit: auditRows, canSeeFullReferences: canSeeFull };
  }

  async listOrders(actor: UserActor, q: { cursor?: string; limit: number; state?: FulfillmentState }) {
    const rows = await this.d.prisma.order.findMany({
      where: orderWhere(actor, q.state ? { fulfillmentState: q.state } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit);
    return { items, nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null };
  }

  /**
   * Updates commercial data and the three independent states (TZ §11.2). Confirming plans the flight
   * reminders; cancelling stops them and closes open CRM tasks.
   */
  async updateOrder(
    actor: UserActor,
    id: string,
    version: number,
    patch: { agreedAmount?: string; currency?: string; saleEvidence?: string | null; note?: string | null; ticketingState?: TicketingState; fulfillmentState?: FulfillmentState; paymentState?: PaymentState },
  ) {
    const result = await this.d.prisma.$transaction(async (tx) => {
      const order = assertFound(await tx.order.findFirst({ where: orderWhere(actor, { id }) }), 'Buyurtma');
      if (!canEditRecord(actor, order.ownerId)) throw forbidden();
      if (order.fulfillmentState === 'cancelled') throw unprocessable('ORDER_CANCELLED', 'Bekor qilingan buyurtmani tahrirlab bo‘lmaydi');
      const data: Prisma.OrderUncheckedUpdateManyInput = { version: { increment: 1 } };
      if (patch.agreedAmount !== undefined || patch.currency !== undefined) {
        const currency = patch.currency ?? order.currency;
        if (!currency || !isSupportedCurrency(currency)) throw unprocessable('INVALID_CURRENCY', 'Valyuta ko‘rsatilmagan', { currency: 'required' });
        const m = parseMoney(patch.agreedAmount ?? formatMoney({ amountMinor: order.agreedAmountMinor ?? 0n, currency }), currency);
        if (m.amountMinor < 0n) throw unprocessable('INVALID_AMOUNT', 'Summa manfiy bo‘lmasin');
        data.agreedAmountMinor = m.amountMinor;
        data.currency = currency;
      }
      if (patch.saleEvidence !== undefined) data.saleEvidence = patch.saleEvidence;
      if (patch.note !== undefined) data.note = patch.note;
      if (patch.ticketingState) data.ticketingState = patch.ticketingState;
      if (patch.paymentState) data.paymentState = patch.paymentState;
      if (patch.fulfillmentState) {
        data.fulfillmentState = patch.fulfillmentState;
        if (patch.fulfillmentState === 'confirmed' && !order.confirmedAt) data.confirmedAt = this.d.clock.now();
        if (patch.fulfillmentState === 'cancelled') data.cancelledAt = this.d.clock.now();
      }
      const res = await tx.order.updateMany({ where: { id, version }, data });
      if (res.count !== 1) throw conflict('VERSION_CONFLICT', 'Buyurtma boshqa foydalanuvchi tomonidan o‘zgartirilgan. Sahifani yangilang.');
      await audit(tx, actor, {
        entityType: 'order',
        entityId: id,
        action: patch.agreedAmount !== undefined ? 'price_updated' : 'updated',
        oldValue: { agreedAmountMinor: order.agreedAmountMinor, currency: order.currency, fulfillmentState: order.fulfillmentState, ticketingState: order.ticketingState, paymentState: order.paymentState },
        newValue: patch,
      });
      const updated = await tx.order.findUniqueOrThrow({ where: { id } });
      await enqueueOutbox(tx, { companyId: actor.companyId, operationKey: `order.summary:${id}:${updated.version}`, target: 'amocrm', action: 'order.summary', payload: { orderId: id, leadId: order.leadId } });
      return { before: order, after: updated };
    });
    const { RemindersService } = await import('./reminders.service');
    const reminders = new RemindersService(this.d);
    if (result.before.fulfillmentState !== result.after.fulfillmentState) {
      if (result.after.fulfillmentState === 'cancelled') await reminders.cancelForOrder(actor, id, 'order_cancelled');
      else if (['confirmed', 'in_progress'].includes(result.after.fulfillmentState)) await reminders.planForOrder(actor.companyId, id);
    }
    await publishEvent(this.d.redis, { companyId: actor.companyId, entityType: 'order', entityId: id, ownerId: result.after.ownerId, kind: 'updated' });
    return result.after;
  }

  /**
   * Records a payment or refund. This does not move money (TZ §12.3). The business key
   * (Idempotency-Key or reference) makes duplicates impossible. Payment state is recomputed only
   * from same-currency records; other currencies are never converted implicitly.
   */
  async recordPayment(
    actor: UserActor,
    orderId: string,
    input: { kind: 'payment' | 'refund'; amount: string; currency: string; receivedAt: Date; method: string; evidence?: string | null; reference?: string | null; businessKey: string },
  ) {
    if (!isSupportedCurrency(input.currency)) throw unprocessable('INVALID_CURRENCY', 'Valyuta qo‘llab-quvvatlanmaydi', { currency: 'unsupported' });
    const money = parseMoney(input.amount, input.currency);
    if (money.amountMinor <= 0n) throw unprocessable('INVALID_AMOUNT', 'Summa musbat bo‘lishi kerak', { amount: 'positive' });
    return this.d.prisma.$transaction(async (tx) => {
      const order = assertFound(await tx.order.findFirst({ where: orderWhere(actor, { id: orderId }) }), 'Buyurtma');
      if (!canEditRecord(actor, order.ownerId)) throw forbidden();
      const dup = await tx.payment.findUnique({ where: { companyId_businessKey: { companyId: actor.companyId, businessKey: input.businessKey } } });
      if (dup) {
        if (dup.orderId !== orderId || dup.amountMinor !== money.amountMinor || dup.currency !== money.currency || dup.kind !== input.kind) {
          throw conflict('IDEMPOTENCY_KEY_REUSED', 'Bu kalit boshqa to‘lov uchun ishlatilgan');
        }
        return { payment: dup, order, duplicate: true, paymentStateNote: null as string | null };
      }
      const payment = await tx.payment.create({
        data: {
          companyId: actor.companyId,
          orderId,
          kind: input.kind,
          amountMinor: money.amountMinor,
          currency: money.currency,
          receivedAt: input.receivedAt,
          method: input.method,
          evidence: input.evidence ?? null,
          reference: input.reference ?? null,
          businessKey: input.businessKey,
          recordedById: actor.id,
        },
      });
      const all = await tx.payment.findMany({ where: { companyId: actor.companyId, orderId, status: 'confirmed' } });
      const { state, note } = computePaymentState(order, all);
      const updated = state && state !== order.paymentState ? await tx.order.update({ where: { id: orderId }, data: { paymentState: state, version: { increment: 1 } } }) : order;
      await audit(tx, actor, { entityType: 'order', entityId: orderId, action: input.kind === 'refund' ? 'refund_recorded' : 'payment_recorded', newValue: { paymentId: payment.id, amount: input.amount, currency: input.currency, method: input.method } });
      return { payment, order: updated, duplicate: false, paymentStateNote: note };
    });
  }

  // ---------- Passengers & services ----------

  async addPassenger(actor: UserActor, orderId: string, input: { fullName: string; type: 'adult' | 'child' | 'infant'; birthDate?: Date | null }) {
    return this.d.prisma.$transaction(async (tx) => {
      const order = assertFound(await tx.order.findFirst({ where: orderWhere(actor, { id: orderId }) }), 'Buyurtma');
      if (!canEditRecord(actor, order.ownerId)) throw forbidden();
      const p = await tx.passenger.create({ data: { companyId: actor.companyId, orderId, fullName: input.fullName, type: input.type, birthDate: input.birthDate ?? null } });
      await audit(tx, actor, { entityType: 'order', entityId: orderId, action: 'passenger_added', newValue: { passengerId: p.id, type: input.type } });
      return p;
    });
  }

  async addService(actor: UserActor, orderId: string, input: { serviceType: string; description: string; amount?: string | null; currency?: string | null }) {
    return this.d.prisma.$transaction(async (tx) => {
      const order = assertFound(await tx.order.findFirst({ where: orderWhere(actor, { id: orderId }) }), 'Buyurtma');
      if (!canEditRecord(actor, order.ownerId)) throw forbidden();
      const m = input.amount && input.currency ? parseMoney(input.amount, input.currency) : null;
      const s = await tx.orderService.create({ data: { companyId: actor.companyId, orderId, serviceType: input.serviceType, description: input.description, amountMinor: m?.amountMinor ?? null, currency: m?.currency ?? null } });
      await audit(tx, actor, { entityType: 'order', entityId: orderId, action: 'service_added', newValue: { serviceId: s.id } });
      return s;
    });
  }

  async addTicket(actor: UserActor, orderId: string, input: { passengerId: string; ticketNumber: string; segmentIds: string[] }) {
    return this.d.prisma.$transaction(async (tx) => {
      const order = assertFound(await tx.order.findFirst({ where: orderWhere(actor, { id: orderId }) }), 'Buyurtma');
      if (!canEditRecord(actor, order.ownerId)) throw forbidden();
      assertFound(await tx.passenger.findFirst({ where: { id: input.passengerId, companyId: actor.companyId, orderId } }), 'Yo‘lovchi');
      const segs = await tx.flightSegment.findMany({ where: { id: { in: input.segmentIds }, companyId: actor.companyId, orderId } });
      if (segs.length !== input.segmentIds.length) throw unprocessable('SEGMENT_INVALID', 'Segment buyurtmaga tegishli emas');
      const t = await tx.ticket.create({ data: { companyId: actor.companyId, passengerId: input.passengerId, ticketNumber: input.ticketNumber } });
      await tx.ticketSegment.createMany({ data: segs.map((s) => ({ companyId: actor.companyId, ticketId: t.id, segmentId: s.id })) });
      await audit(tx, actor, { entityType: 'order', entityId: orderId, action: 'ticket_added', newValue: { ticketId: t.id, segments: input.segmentIds } });
      return t;
    });
  }
}

export function computePaymentState(order: Pick<Order, 'agreedAmountMinor' | 'currency' | 'paymentState'>, payments: Array<{ kind: string; amountMinor: bigint; currency: string }>): { state: PaymentState | null; note: string | null } {
  const paid = sumByCurrency(payments.filter((p) => p.kind === 'payment').map((p) => ({ amountMinor: p.amountMinor, currency: p.currency })));
  const refunded = sumByCurrency(payments.filter((p) => p.kind === 'refund').map((p) => ({ amountMinor: p.amountMinor, currency: p.currency })));
  const currencies = new Set([...Object.keys(paid), ...Object.keys(refunded)]);
  if (!order.currency || order.agreedAmountMinor === null) return { state: null, note: 'Kelishilgan summa yo‘q: to‘lov holati qo‘lda belgilanadi' };
  if ([...currencies].some((c) => c !== order.currency)) {
    return { state: null, note: 'Buyurtma valyutasidan farqli to‘lov bor: kurs tasdiqlanmaguncha holat avtomatik hisoblanmaydi' };
  }
  const p = paid[order.currency] ?? 0n;
  const r = refunded[order.currency] ?? 0n;
  if (r > 0n && r >= p) return { state: 'refunded', note: null };
  const net = p - r;
  if (net <= 0n) return { state: 'unpaid', note: null };
  if (net >= order.agreedAmountMinor) return { state: 'paid', note: null };
  return { state: 'partial', note: null };
}
