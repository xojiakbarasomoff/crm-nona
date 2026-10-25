import type { FulfillmentState, Order, OrderService as ServiceRow, PaymentState, Prisma, SupplierRefund, TicketingState, Tx } from '@crm/database';
import { validateServiceDetails } from '@crm/contracts';
import { can, checkCustomerRefund, checkSupplierRefund, computeOrderFinance, formatMoney, formatOrderNo, isSupportedCurrency, marginPercent, parseMoney, singleCurrencySelling, sumByCurrency, type FinanceLine, type OrderFinance, type RefundsByCurrency } from '@crm/domain';
import { audit } from '../audit';
import type { CoreDeps, UserActor } from '../context';
import { publishEvent } from '../events';
import { conflict, forbidden, isPgUniqueViolation, unprocessable } from '../errors';
import { enqueueOutbox } from '../queue';
import { assertFound, canCost, canEditRecord, leadWhere, orderWhere, requireCost } from '../scope';
import { assertSelectableSupplier, serializeSupplier } from './suppliers.service';

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
  p: { companyId: string; leadId: string; contactId: string; ownerId: string | null; now: Date; fulfillmentState: FulfillmentState; agreedAmountMinor?: bigint | null; currency?: string | null; offerVersionId?: string | null; note?: string | null; tourOperatorId?: string | null },
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
      // Tarixiy bog'lanish: yaratilgan paytdagi lid turoperatori. Keyin lid o'zgarsa ham o'zgarmaydi.
      tourOperatorId: p.tourOperatorId ?? null,
    },
  });
  await enqueueOutbox(tx, { companyId: p.companyId, operationKey: `order.summary:${order.id}:1`, target: 'amocrm', action: 'order.summary', payload: { orderId: order.id, leadId: p.leadId } });
  return order;
}

/** Tannarx (netPrice) faqat `finance.cost.view` huquqi bor foydalanuvchiga qaytariladi (backend darajasida). */
export function serializeOrder(o: Order, canCost: boolean) {
  return {
    ...o,
    /** Paket darajasidagi sotuv narxi (selling price). */
    agreedAmount: o.agreedAmountMinor !== null && o.currency ? formatMoney({ amountMinor: o.agreedAmountMinor, currency: o.currency }) : null,
    /** Paket darajasidagi tannarx (net price); null — noma'lum yoki ko'rish huquqi yo'q (`costHidden`). */
    netPrice: canCost && o.netPriceMinor !== null && o.currency ? formatMoney({ amountMinor: o.netPriceMinor, currency: o.currency }) : null,
    costHidden: !canCost,
    agreedAmountMinor: undefined,
    netPriceMinor: undefined,
  };
}

const fmt = (amountMinor: bigint, currency: string) => formatMoney({ amountMinor, currency });

export function serializeService(s: ServiceRow, canCost: boolean) {
  const ccy = s.currency;
  const known = canCost && s.amountMinor !== null && s.netMinor !== null && !!ccy;
  return {
    id: s.id,
    serviceType: s.serviceType,
    description: s.description,
    /** Sotuv narxi (mijozga). */
    amount: s.amountMinor !== null && ccy ? fmt(s.amountMinor, ccy) : null,
    /** Tannarx (yetkazib beruvchidan); null — noma'lum yoki ko'rish huquqi yo'q. */
    netAmount: canCost && s.netMinor !== null && ccy ? fmt(s.netMinor, ccy) : null,
    currency: ccy,
    profit: known ? fmt(s.amountMinor! - s.netMinor!, ccy!) : null,
    supplierId: s.supplierId,
    includedInPackage: s.includedInPackage,
    details: s.details,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** Buyurtma (paket) va xizmat qatorlaridan hisob qatorlari. Olib tashlangan xizmatlar `removed` bilan belgilanadi. */
export function orderFinanceLines(o: Pick<Order, 'id' | 'agreedAmountMinor' | 'netPriceMinor' | 'currency'>, services: ServiceRow[]): FinanceLine[] {
  const lines: FinanceLine[] = [];
  if (o.currency && (o.agreedAmountMinor !== null || o.netPriceMinor !== null)) {
    lines.push({ kind: 'package', id: `package:${o.id}`, sellingMinor: o.agreedAmountMinor, netMinor: o.netPriceMinor, currency: o.currency });
  }
  for (const s of services) {
    lines.push({ kind: 'service', id: s.id, sellingMinor: s.amountMinor, netMinor: s.netMinor, currency: s.currency, includedInPackage: s.includedInPackage, removed: !!s.removedAt });
  }
  return lines;
}

export const orderFinance = (o: Pick<Order, 'id' | 'agreedAmountMinor' | 'netPriceMinor' | 'currency'>, services: ServiceRow[], refunds: RefundsByCurrency = {}) => computeOrderFinance(orderFinanceLines(o, services), refunds);

export const FINANCE_FORMULA =
  "Dastlabki foyda = sotuv narxi (selling price) − tannarx (net price). Qaytarimdan keyingi foyda = (sotuv narxi − mijozga qaytarilgan summa) − (tannarx − yetkazib beruvchidan qaytgan summa). Qo'shimcha xarajatlar (komissiya, soliq, bank to'lovlari, valyuta farqi) hisobga olinmagan: bu buxgalteriya bo'yicha yakuniy «sof foyda» emas.";

type Db = { payment: Tx['payment']; supplierRefund: Tx['supplierRefund'] };

/** Buyurtma qaytarimlari: mijozga qaytarilgan (payments.kind='refund') va yetkazib beruvchidan qaytgan — valyuta bo'yicha. */
export async function loadRefunds(db: Db, companyId: string, orderIds: string[]) {
  const byOrder = new Map<string, { refunds: RefundsByCurrency; received: Record<string, bigint> }>();
  if (!orderIds.length) return byOrder;
  const get = (id: string) => byOrder.get(id) ?? (byOrder.set(id, { refunds: {}, received: {} }), byOrder.get(id)!);
  const [pay, sup] = await Promise.all([
    db.payment.groupBy({ by: ['orderId', 'currency', 'kind'], where: { companyId, orderId: { in: orderIds }, status: 'confirmed' }, _sum: { amountMinor: true } }),
    db.supplierRefund.groupBy({ by: ['orderId', 'currency'], where: { companyId, orderId: { in: orderIds } }, _sum: { amountMinor: true } }),
  ]);
  for (const r of pay) {
    const o = get(r.orderId);
    const sum = r._sum.amountMinor ?? 0n;
    if (r.kind === 'refund') (o.refunds[r.currency] ??= { customerMinor: 0n, supplierMinor: 0n }).customerMinor += sum;
    else o.received[r.currency] = (o.received[r.currency] ?? 0n) + sum;
  }
  for (const r of sup) (get(r.orderId).refunds[r.currency] ??= { customerMinor: 0n, supplierMinor: 0n }).supplierMinor += r._sum.amountMinor ?? 0n;
  return byOrder;
}

/** Foydalanuvchida tannarx/foyda huquqi bo'lmasa — faqat sotuv va mijoz qaytarimi qaytariladi. */
export function serializeFinance(f: OrderFinance, canCost: boolean) {
  const rows = Object.values(f.byCurrency).map((c) => {
    const base = {
      selling: fmt(c.sellingMinor, c.currency),
      customerRefunded: fmt(c.customerRefundedMinor, c.currency),
      sellingAfterRefund: fmt(c.sellingAfterRefundMinor, c.currency),
      lines: c.lines,
    };
    if (!canCost) return [c.currency, base] as const;
    return [
      c.currency,
      {
        ...base,
        net: c.lines - c.missingNetLines > 0 ? fmt(c.netMinor, c.currency) : null,
        netComplete: c.missingNetLines === 0 && c.missingSellingLines === 0,
        /** Dastlabki foyda (qaytarimsiz). */
        profit: c.profitMinor === null ? null : fmt(c.profitMinor, c.currency),
        profitState: c.profitState,
        marginPercent: c.profitMinor === null ? null : marginPercent(c.sellingMinor, c.profitMinor),
        supplierRefunded: fmt(c.supplierRefundedMinor, c.currency),
        netAfterRefund: c.netAfterRefundMinor === null ? null : fmt(c.netAfterRefundMinor, c.currency),
        /** Qaytarimdan keyingi foyda. */
        profitAfterRefund: c.profitAfterRefundMinor === null ? null : fmt(c.profitAfterRefundMinor, c.currency),
        missingNetLines: c.missingNetLines,
      },
    ] as const;
  });
  return {
    costHidden: !canCost,
    hasPrice: f.hasPrice,
    profitUndetermined: canCost ? f.profitUndetermined : null,
    refundCurrencyMismatch: f.refundCurrencyMismatch.length > 0,
    byCurrency: Object.fromEntries(rows),
    formula: canCost ? FINANCE_FORMULA : null,
  };
}

/** Auditdan tannarxga oid kalitlarni olib tashlaydi (huquqsiz foydalanuvchi uchun). */
function stripCost(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripCost);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !/net/i.test(k)).map(([k, x]) => [k, stripCost(x)]));
  return v;
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
      await tx.lead.updateMany({ where: { id: leadId, firstHumanActionAt: null }, data: { firstHumanActionAt: this.d.clock.now() } });
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
        const order = await createOrderRow(tx, { companyId: actor.companyId, leadId: lead.id, contactId: lead.contactId, ownerId: lead.ownerId, now: this.d.clock.now(), fulfillmentState: 'draft', agreedAmountMinor: amountMinor, currency, offerVersionId, note: input.note ?? null, tourOperatorId: lead.tourOperatorId });
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
          services: { where: { removedAt: null }, orderBy: { createdAt: 'asc' } },
          passengers: { include: { segments: true, tickets: { include: { segments: true } } } },
          segments: { orderBy: { segmentNo: 'asc' }, include: { passengers: true, checks: { orderBy: { checkedAt: 'desc' }, take: 20 } } },
          payments: { orderBy: { receivedAt: 'asc' } },
        },
      }),
      'Buyurtma',
    );
    const canSeeFull = actor.role !== 'MANAGER' || order.ownerId === actor.id;
    const cost = canCost(actor);
    const [lead, contact, reminders, auditRows, supplierRefunds, refundMap] = await Promise.all([
      this.d.prisma.lead.findFirst({ where: { id: order.leadId, companyId: actor.companyId }, select: { id: true, name: true, stage: true, version: true, amoLeadId: true, serviceType: true, requirements: true, tourOperatorId: true, ownerId: true, firstWonAt: true } }),
      this.d.prisma.contact.findFirst({ where: { id: order.contactId, companyId: actor.companyId }, select: { id: true, fullName: true, primaryPhone: true, primaryEmail: true } }),
      this.d.prisma.reminderOccurrence.findMany({ where: { companyId: actor.companyId, orderId: id }, orderBy: { dueAt: 'asc' } }),
      this.d.prisma.auditLog.findMany({ where: { companyId: actor.companyId, entityId: { in: [id, ...order.segments.map((s) => s.id)] } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      cost ? this.d.prisma.supplierRefund.findMany({ where: { companyId: actor.companyId, orderId: id }, orderBy: { receivedAt: 'asc' } }) : Promise.resolve([] as SupplierRefund[]),
      loadRefunds(this.d.prisma, actor.companyId, [id]),
    ]);
    const supplierIds = [...new Set([order.tourOperatorId, ...order.services.map((s) => s.supplierId), ...supplierRefunds.map((r) => r.supplierId)].filter((x): x is string => !!x))];
    const suppliers = supplierIds.length ? await this.d.prisma.supplier.findMany({ where: { companyId: actor.companyId, id: { in: supplierIds } } }) : [];
    const full = can(actor.role, 'reference.view_full');
    const supplierMap = Object.fromEntries(suppliers.map((x) => [x.id, serializeSupplier(x, full)]));
    const refunds = refundMap.get(id)?.refunds ?? {};
    const finance = serializeFinance(orderFinance(order, order.services, refunds), cost);
    // Huquqsiz foydalanuvchiga tannarx, foyda va yetkazib beruvchi qaytarimlari audit orqali ham sizib chiqmasin.
    const auditOut = cost ? auditRows : auditRows.filter((r) => r.action !== 'supplier_refund_recorded').map((r) => ({ ...r, oldValue: stripCost(r.oldValue), newValue: stripCost(r.newValue) }));
    return {
      order,
      lead,
      contact,
      reminders,
      audit: auditOut,
      canSeeFullReferences: canSeeFull,
      canCost: cost,
      finance,
      supplierRefunds: supplierRefunds.map((r) => ({ id: r.id, serviceId: r.serviceId, supplierId: r.supplierId, amount: fmt(r.amountMinor, r.currency), currency: r.currency, receivedAt: r.receivedAt, reference: r.reference, note: r.note })),
      suppliers: supplierMap,
      /** Buyurtma turoperatori (tarixiy bog'lanish; lid operatori o'zgarsa ham saqlanadi). */
      tourOperator: order.tourOperatorId ? (supplierMap[order.tourOperatorId] ?? null) : null,
    };
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
    patch: { agreedAmount?: string; netPrice?: string | null; tourOperatorId?: string | null; tourOperatorReason?: string | null; currency?: string; saleEvidence?: string | null; note?: string | null; ticketingState?: TicketingState; fulfillmentState?: FulfillmentState; paymentState?: PaymentState },
  ) {
    const result = await this.d.prisma.$transaction(async (tx) => {
      const order = assertFound(await tx.order.findFirst({ where: orderWhere(actor, { id }) }), 'Buyurtma');
      if (!canEditRecord(actor, order.ownerId)) throw forbidden();
      if (order.fulfillmentState === 'cancelled') throw unprocessable('ORDER_CANCELLED', 'Bekor qilingan buyurtmani tahrirlab bo‘lmaydi');
      const data: Prisma.OrderUncheckedUpdateManyInput = { version: { increment: 1 } };
      if (patch.netPrice !== undefined) requireCost(actor);
      const pricing = patch.agreedAmount !== undefined || patch.currency !== undefined || patch.netPrice !== undefined;
      let operatorChange: { from: string | null; to: string | null; reason: string | null } | null = null;
      if (patch.tourOperatorId !== undefined && patch.tourOperatorId !== order.tourOperatorId) {
        // Buyurtma turoperatorini alohida, sabab va audit bilan o'zgartirish (lid operatori bunga ta'sir qilmaydi).
        const lead = await tx.lead.findFirst({ where: { id: order.leadId, companyId: actor.companyId }, select: { firstWonAt: true } });
        const confirmedLike = order.fulfillmentState !== 'draft' || !!order.confirmedAt || !!lead?.firstWonAt;
        const reason = patch.tourOperatorReason?.trim() || null;
        if (confirmedLike && (!reason || reason.length < 3)) throw unprocessable('REASON_REQUIRED', 'Tasdiqlangan buyurtma turoperatorini o‘zgartirish uchun sabab kerak', { tourOperatorReason: 'required' });
        if (patch.tourOperatorId) await assertSelectableSupplier(tx, actor.companyId, patch.tourOperatorId, { kind: 'tour_operator' });
        data.tourOperatorId = patch.tourOperatorId;
        operatorChange = { from: order.tourOperatorId, to: patch.tourOperatorId, reason };
      }
      if (pricing) {
        const currency = patch.currency ?? order.currency;
        if (!currency || !isSupportedCurrency(currency)) throw unprocessable('INVALID_CURRENCY', 'Valyuta ko‘rsatilmagan', { currency: 'required' });
        const hasAmounts = order.agreedAmountMinor !== null || order.netPriceMinor !== null;
        if (order.currency && currency !== order.currency && hasAmounts && (patch.agreedAmount === undefined || patch.netPrice === undefined)) {
          throw unprocessable('CURRENCY_CHANGE_REQUIRES_AMOUNTS', 'Valyutani o‘zgartirishda sotuv narxi va tannarx qayta kiritilishi kerak (kurs bo‘yicha avtomatik o‘zgartirilmaydi)', { currency: 'amounts_required' });
        }
        if (patch.agreedAmount !== undefined) {
          const m = parseMoney(patch.agreedAmount, currency);
          if (m.amountMinor < 0n) throw unprocessable('INVALID_AMOUNT', 'Sotuv narxi manfiy bo‘lmasin', { agreedAmount: 'negative' });
          data.agreedAmountMinor = m.amountMinor;
        }
        if (patch.netPrice !== undefined) {
          if (patch.netPrice === null) data.netPriceMinor = null;
          else {
            const m = parseMoney(patch.netPrice, currency);
            if (m.amountMinor < 0n) throw unprocessable('INVALID_AMOUNT', 'Tannarx manfiy bo‘lmasin', { netPrice: 'negative' });
            data.netPriceMinor = m.amountMinor;
          }
        }
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
      if (operatorChange) {
        await audit(tx, actor, { entityType: 'order', entityId: id, action: 'tour_operator_changed', oldValue: { tourOperatorId: operatorChange.from }, newValue: { tourOperatorId: operatorChange.to, reason: operatorChange.reason } });
      }
      await audit(tx, actor, {
        entityType: 'order',
        entityId: id,
        action: pricing ? 'price_updated' : 'updated',
        oldValue: { agreedAmountMinor: order.agreedAmountMinor, netPriceMinor: order.netPriceMinor, currency: order.currency, fulfillmentState: order.fulfillmentState, ticketingState: order.ticketingState, paymentState: order.paymentState },
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
      if (input.kind === 'refund') {
        // Mijozga qaytarim: valyuta buyurtma narxlariga mos, qabul qilingan to'lovdan oshmasin (kurs yo'q).
        const svc = await tx.orderService.findMany({ where: { companyId: actor.companyId, orderId, removedAt: null } });
        const fin = orderFinance(order, svc);
        if (!fin.hasPrice) throw unprocessable('PRICE_REQUIRED', 'Qaytarimni yozishdan oldin buyurtma narxini kiriting', { amount: 'price_required' });
        const sums = (await loadRefunds(tx, actor.companyId, [orderId])).get(orderId);
        const check = checkCustomerRefund(fin, { currency: money.currency, amountMinor: money.amountMinor, receivedMinor: sums?.received[money.currency] ?? 0n, refundedMinor: sums?.refunds[money.currency]?.customerMinor ?? 0n });
        if (!check.ok) throw unprocessable(check.code, check.message, { currency: check.code === 'REFUND_CURRENCY_MISMATCH' ? 'mismatch' : 'invalid', amount: check.code === 'REFUND_EXCEEDS_RECEIVED' ? 'exceeds_received' : 'ok' });
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
      // To'lov holati paket + paketdan tashqari xizmatlarning jami sotuv narxiga nisbatan hisoblanadi (yagona valyutada).
      const svcRows = await tx.orderService.findMany({ where: { companyId: actor.companyId, orderId, removedAt: null } });
      const eff = singleCurrencySelling(orderFinance(order, svcRows));
      const { state, note } = computePaymentState(eff ? { ...order, agreedAmountMinor: eff.amountMinor, currency: eff.currency } : { ...order, agreedAmountMinor: null }, all);
      const updated = state && state !== order.paymentState ? await tx.order.update({ where: { id: orderId }, data: { paymentState: state, version: { increment: 1 } } }) : order;
      await audit(tx, actor, { entityType: 'order', entityId: orderId, action: input.kind === 'refund' ? 'refund_recorded' : 'payment_recorded', newValue: { paymentId: payment.id, amount: input.amount, currency: input.currency, method: input.method } });
      return { payment, order: updated, duplicate: false, paymentStateNote: note };
    });
  }

  /**
   * Yetkazib beruvchidan qaytgan summa (mijozga qaytarimdan alohida qayd etiladi). Faqat `finance.cost.view` huquqi.
   * Valyuta buyurtma narx valyutasiga mos bo'lishi va jami qaytgan summa tannarxdan oshmasligi shart (kurs yo'q).
   */
  async recordSupplierRefund(
    actor: UserActor,
    orderId: string,
    input: { amount: string; currency: string; receivedAt: Date; supplierId?: string | null; serviceId?: string | null; reference?: string | null; note?: string | null; businessKey: string },
  ) {
    requireCost(actor);
    if (!isSupportedCurrency(input.currency)) throw unprocessable('INVALID_CURRENCY', 'Valyuta qo‘llab-quvvatlanmaydi', { currency: 'unsupported' });
    const money = parseMoney(input.amount, input.currency);
    if (money.amountMinor <= 0n) throw unprocessable('INVALID_AMOUNT', 'Summa musbat bo‘lishi kerak', { amount: 'positive' });
    return this.d.prisma.$transaction(async (tx) => {
      const order = assertFound(await tx.order.findFirst({ where: orderWhere(actor, { id: orderId }) }), 'Buyurtma');
      if (!canEditRecord(actor, order.ownerId)) throw forbidden();
      const dup = await tx.supplierRefund.findUnique({ where: { companyId_businessKey: { companyId: actor.companyId, businessKey: input.businessKey } } });
      if (dup) {
        if (dup.orderId !== orderId || dup.amountMinor !== money.amountMinor || dup.currency !== money.currency) throw conflict('IDEMPOTENCY_KEY_REUSED', 'Bu kalit boshqa qaytarim uchun ishlatilgan');
        return { refund: dup, duplicate: true };
      }
      if (input.supplierId) assertFound(await tx.supplier.findFirst({ where: { id: input.supplierId, companyId: actor.companyId } }), 'Yetkazib beruvchi');
      if (input.serviceId) assertFound(await tx.orderService.findFirst({ where: { id: input.serviceId, companyId: actor.companyId, orderId } }), 'Xizmat');
      const svc = await tx.orderService.findMany({ where: { companyId: actor.companyId, orderId, removedAt: null } });
      const fin = orderFinance(order, svc);
      const sums = (await loadRefunds(tx, actor.companyId, [orderId])).get(orderId);
      const check = checkSupplierRefund(fin, { currency: money.currency, amountMinor: money.amountMinor, refundedMinor: sums?.refunds[money.currency]?.supplierMinor ?? 0n });
      if (!check.ok) throw unprocessable(check.code, check.message, { currency: check.code === 'REFUND_CURRENCY_MISMATCH' ? 'mismatch' : 'invalid', amount: check.code === 'SUPPLIER_REFUND_EXCEEDS_NET' ? 'exceeds_net' : 'ok' });
      const refund = await tx.supplierRefund.create({
        data: { companyId: actor.companyId, orderId, serviceId: input.serviceId ?? null, supplierId: input.supplierId ?? null, amountMinor: money.amountMinor, currency: money.currency, receivedAt: input.receivedAt, reference: input.reference ?? null, note: input.note ?? null, businessKey: input.businessKey, recordedById: actor.id },
      });
      await audit(tx, actor, { entityType: 'order', entityId: orderId, action: 'supplier_refund_recorded', newValue: { supplierRefundId: refund.id, amount: input.amount, currency: input.currency, supplierId: input.supplierId ?? null, serviceId: input.serviceId ?? null } });
      return { refund, duplicate: false };
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

  private moneyPair(amount: string | null | undefined, net: string | null | undefined, currency: string | null | undefined) {
    if ((amount || net) && !currency) throw unprocessable('INVALID_CURRENCY', 'Narx kiritilganda valyuta majburiy', { currency: 'required' });
    if (currency && !isSupportedCurrency(currency)) throw unprocessable('INVALID_CURRENCY', 'Valyuta qo‘llab-quvvatlanmaydi', { currency: 'unsupported' });
    const sell = amount ? parseMoney(amount, currency!) : null;
    const cost = net ? parseMoney(net, currency!) : null;
    if (sell && sell.amountMinor < 0n) throw unprocessable('INVALID_AMOUNT', 'Sotuv narxi manfiy bo‘lmasin', { amount: 'negative' });
    if (cost && cost.amountMinor < 0n) throw unprocessable('INVALID_AMOUNT', 'Tannarx manfiy bo‘lmasin', { netAmount: 'negative' });
    return { sell: sell?.amountMinor ?? null, cost: cost?.amountMinor ?? null };
  }

  /** Xizmat qatori o'zgarsa, amoCRM'dagi sotuv jami (order.summary) qayta yuboriladi; tannarx/foyda yuborilmaydi. */
  private async queueSummary(tx: Tx, actor: UserActor, order: Pick<Order, 'id' | 'leadId'>, token: string) {
    await enqueueOutbox(tx, { companyId: actor.companyId, operationKey: `order.summary:${order.id}:svc:${token}:${this.d.clock.now().getTime()}`, target: 'amocrm', action: 'order.summary', payload: { orderId: order.id, leadId: order.leadId } });
  }

  async addService(
    actor: UserActor,
    orderId: string,
    input: { serviceType: string; description: string; amount?: string | null; netAmount?: string | null; currency?: string | null; supplierId?: string | null; includedInPackage?: boolean; details?: Record<string, unknown> },
  ) {
    if (input.netAmount) requireCost(actor);
    const { sell, cost } = this.moneyPair(input.amount, input.netAmount, input.currency);
    const det = validateServiceDetails(input.serviceType, input.details);
    if (!det.ok) throw unprocessable('VALIDATION_FAILED', 'Kiritilgan ma’lumot noto‘g‘ri', det.errors);
    return this.d.prisma.$transaction(async (tx) => {
      const order = assertFound(await tx.order.findFirst({ where: orderWhere(actor, { id: orderId }) }), 'Buyurtma');
      if (!canEditRecord(actor, order.ownerId)) throw forbidden();
      if (order.fulfillmentState === 'cancelled') throw unprocessable('ORDER_CANCELLED', 'Bekor qilingan buyurtmani tahrirlab bo‘lmaydi');
      if (input.supplierId) await assertSelectableSupplier(tx, actor.companyId, input.supplierId);
      const s = await tx.orderService.create({
        data: {
          companyId: actor.companyId,
          orderId,
          serviceType: input.serviceType,
          description: input.description,
          amountMinor: sell,
          netMinor: cost,
          currency: input.currency ?? null,
          supplierId: input.supplierId ?? null,
          includedInPackage: input.includedInPackage ?? false,
          details: det.value as Prisma.InputJsonValue,
        },
      });
      await audit(tx, actor, {
        entityType: 'order',
        entityId: orderId,
        action: 'service_added',
        newValue: { serviceId: s.id, serviceType: s.serviceType, amount: input.amount ?? null, netAmount: input.netAmount ?? null, currency: s.currency, supplierId: s.supplierId, includedInPackage: s.includedInPackage },
      });
      await this.queueSummary(tx, actor, order, s.id);
      return serializeService(s, canCost(actor));
    });
  }

  async updateService(
    actor: UserActor,
    serviceId: string,
    patch: { serviceType?: string; description?: string; amount?: string | null; netAmount?: string | null; currency?: string | null; supplierId?: string | null; includedInPackage?: boolean; details?: Record<string, unknown> },
  ) {
    if (patch.netAmount !== undefined) requireCost(actor);
    return this.d.prisma.$transaction(async (tx) => {
      const before = assertFound(await tx.orderService.findFirst({ where: { id: serviceId, companyId: actor.companyId, removedAt: null } }), 'Xizmat');
      const order = assertFound(await tx.order.findFirst({ where: orderWhere(actor, { id: before.orderId }) }), 'Xizmat');
      if (!canEditRecord(actor, order.ownerId)) throw forbidden();
      if (order.fulfillmentState === 'cancelled') throw unprocessable('ORDER_CANCELLED', 'Bekor qilingan buyurtmani tahrirlab bo‘lmaydi');
      const currency = patch.currency !== undefined ? patch.currency : before.currency;
      const hasAmounts = before.amountMinor !== null || before.netMinor !== null;
      if (patch.currency !== undefined && before.currency && patch.currency !== before.currency && hasAmounts && (patch.amount === undefined || patch.netAmount === undefined)) {
        throw unprocessable('CURRENCY_CHANGE_REQUIRES_AMOUNTS', 'Valyutani o‘zgartirishda sotuv narxi va tannarx qayta kiritilishi kerak', { currency: 'amounts_required' });
      }
      const curText = (v: bigint | null) => (v !== null && before.currency ? fmt(v, before.currency) : null);
      const { sell, cost } = this.moneyPair(patch.amount !== undefined ? patch.amount : curText(before.amountMinor), patch.netAmount !== undefined ? patch.netAmount : curText(before.netMinor), currency);
      const type = patch.serviceType ?? before.serviceType;
      const det = validateServiceDetails(type, patch.details ?? (before.details as Record<string, unknown>));
      if (!det.ok) throw unprocessable('VALIDATION_FAILED', 'Kiritilgan ma’lumot noto‘g‘ri', det.errors);
      if (patch.supplierId) await assertSelectableSupplier(tx, actor.companyId, patch.supplierId, { unchanged: patch.supplierId === before.supplierId });
      const after = await tx.orderService.update({
        where: { id: serviceId },
        data: {
          serviceType: type,
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          amountMinor: sell,
          netMinor: cost,
          currency: currency ?? null,
          ...(patch.supplierId !== undefined ? { supplierId: patch.supplierId } : {}),
          ...(patch.includedInPackage !== undefined ? { includedInPackage: patch.includedInPackage } : {}),
          details: det.value as Prisma.InputJsonValue,
        },
      });
      const priceChanged = before.amountMinor !== after.amountMinor || before.netMinor !== after.netMinor || before.currency !== after.currency || before.includedInPackage !== after.includedInPackage;
      const snap = (r: ServiceRow) => ({
        serviceId,
        amount: r.amountMinor !== null && r.currency ? fmt(r.amountMinor, r.currency) : null,
        netAmount: r.netMinor !== null && r.currency ? fmt(r.netMinor, r.currency) : null,
        currency: r.currency,
        supplierId: r.supplierId,
        includedInPackage: r.includedInPackage,
      });
      await audit(tx, actor, { entityType: 'order', entityId: before.orderId, action: priceChanged ? 'service_price_updated' : 'service_updated', oldValue: snap(before), newValue: snap(after) });
      if (priceChanged) await this.queueSummary(tx, actor, order, serviceId);
      return serializeService(after, canCost(actor));
    });
  }

  /** Soft-delete: qator tarixda (auditda) qoladi va hisobga kirmaydi. */
  async removeService(actor: UserActor, serviceId: string) {
    return this.d.prisma.$transaction(async (tx) => {
      const before = assertFound(await tx.orderService.findFirst({ where: { id: serviceId, companyId: actor.companyId, removedAt: null } }), 'Xizmat');
      const order = assertFound(await tx.order.findFirst({ where: orderWhere(actor, { id: before.orderId }) }), 'Xizmat');
      if (!canEditRecord(actor, order.ownerId)) throw forbidden();
      if (order.fulfillmentState === 'cancelled') throw unprocessable('ORDER_CANCELLED', 'Bekor qilingan buyurtmani tahrirlab bo‘lmaydi');
      await tx.orderService.update({ where: { id: serviceId }, data: { removedAt: this.d.clock.now() } });
      await audit(tx, actor, {
        entityType: 'order',
        entityId: before.orderId,
        action: 'service_removed',
        oldValue: { serviceId, serviceType: before.serviceType, amount: before.amountMinor !== null && before.currency ? fmt(before.amountMinor, before.currency) : null, netAmount: before.netMinor !== null && before.currency ? fmt(before.netMinor, before.currency) : null, currency: before.currency },
      });
      await this.queueSummary(tx, actor, order, serviceId);
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
