import type { Lead, Order, Prisma, ReminderOccurrence, Tx } from '@crm/database';
import { formatMoney, isSupportedCurrency, parseMoney } from '@crm/domain';
import { audit } from '../audit';
import type { CoreDeps, UserActor } from '../context';
import { publishEvent } from '../events';
import { forbidden, unprocessable } from '../errors';
import { assertFound, canCost, canEditRecord, leadWhere, ownerFilter, requireCap, requireCost } from '../scope';
import { assertSelectableSupplier } from './suppliers.service';

export const SALE_SERVICE_TYPES = ['avia', 'tour_package', 'other'] as const;
export type SaleServiceType = (typeof SALE_SERVICE_TYPES)[number];
export const SALE_SERVICE_LABELS_RU: Record<SaleServiceType, string> = { avia: 'Авиабилет', tour_package: 'Турпакет', other: 'Другое' };

export const DEFAULT_REMINDER_TZ = 'Asia/Tashkent';
const REMIND_BEFORE_MS = 3 * 24 * 3600_000;
const ACTIVE = ['scheduled', 'dispatching', 'due', 'snoozed'] as const;
const KEY_PREFIX = 'lead-departure:';

export interface SaleInput {
  serviceType: SaleServiceType;
  soldWhat?: string | null;
  tourOperatorId?: string | null;
  amount?: string | null;
  netAmount?: string | null;
  currency?: string | null;
  departureAt?: string | null;
  departureNote?: string | null;
  remindEnabled: boolean;
  remindAt?: string | null;
  timezone: string;
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function formatInZone(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d).replace(',', '');
}

/** Состояние напоминания о вылете для карточки и панели. */
export function reminderView(order: Pick<Order, 'remindEnabled' | 'remindAt' | 'departureAt' | 'remindTimezone'>, occ: Pick<ReminderOccurrence, 'state' | 'dueAt'> | null, now: Date) {
  const timezone = order.remindTimezone ?? DEFAULT_REMINDER_TZ;
  if (!order.remindEnabled) return { state: 'off' as const, dueAt: null, timezone };
  if (!occ) return { state: order.departureAt && order.departureAt <= now ? ('departed' as const) : ('off' as const), dueAt: null, timezone };
  const state = occ.state === 'due' ? 'due' : occ.state === 'completed' ? 'done' : (ACTIVE as readonly string[]).includes(occ.state) ? 'scheduled' : occ.state === 'missed' ? 'departed' : 'off';
  return { state: state as 'due' | 'done' | 'scheduled' | 'departed' | 'off', dueAt: occ.dueAt, timezone };
}

export class SaleService {
  constructor(private readonly d: CoreDeps) {}

  /** Блок «Продажа» для карточки лида: только активный заказ; прибыль — только при известных обеих ценах и праве на себестоимость. */
  async view(actor: UserActor, lead: Lead) {
    const order = await this.d.prisma.order.findFirst({ where: { companyId: actor.companyId, leadId: lead.id, fulfillmentState: { not: 'cancelled' } } });
    if (!order) return null;
    const cost = canCost(actor);
    const occ = await this.currentOccurrence(this.d.prisma as unknown as Tx, order);
    const money = (m: bigint | null) => (m !== null && order.currency ? formatMoney({ amountMinor: m, currency: order.currency }) : null);
    const profitKnown = cost && order.currency !== null && order.agreedAmountMinor !== null && order.netPriceMinor !== null;
    const op = order.tourOperatorId ? await this.d.prisma.supplier.findFirst({ where: { id: order.tourOperatorId, companyId: actor.companyId }, select: { id: true, name: true } }) : null;
    return {
      orderId: order.id,
      orderNo: order.orderNo,
      version: order.version,
      serviceType: order.saleServiceType as SaleServiceType | null,
      soldWhat: order.soldWhat,
      tourOperator: op,
      currency: order.currency,
      amount: money(order.agreedAmountMinor),
      netAmount: cost ? money(order.netPriceMinor) : null,
      /** Прибыль = Цена продажи − Себестоимость (одна валюта); null — неизвестна или скрыта. */
      profit: profitKnown ? money(order.agreedAmountMinor! - order.netPriceMinor!) : null,
      costHidden: !cost,
      departureAt: order.departureAt,
      departureNote: order.departureNote,
      remindEnabled: order.remindEnabled,
      remindAt: order.remindAt,
      reminder: reminderView(order, occ, this.d.clock.now()),
    };
  }

  /**
   * Сохраняет блок «Продажа» (лид должен быть «Продано»). Один активный заказ на лид: повторное сохранение
   * обновляет тот же заказ. Изменения цен пишутся в журнал (price_updated), как и в карточке заказа.
   */
  async save(actor: UserActor, leadId: string, input: SaleInput) {
    requireCap(actor, 'leads.work');
    if (input.netAmount !== undefined) requireCost(actor);
    if (!validTimezone(input.timezone)) throw unprocessable('INVALID_TIMEZONE', 'Неизвестный часовой пояс', { timezone: 'invalid' });
    if (input.serviceType === 'other' && !input.soldWhat?.trim()) throw unprocessable('SOLD_WHAT_REQUIRED', 'Укажите, что продано', { soldWhat: 'required' });
    const now = this.d.clock.now();
    const departureAt = input.departureAt ? new Date(input.departureAt) : null;
    const remindAt = input.remindAt ? new Date(input.remindAt) : null;
    if (input.remindEnabled && !departureAt) throw unprocessable('DEPARTURE_REQUIRED', 'Для напоминания укажите дату и время вылета', { departureAt: 'required' });
    if (input.remindEnabled && remindAt && departureAt && remindAt >= departureAt) throw unprocessable('REMIND_AFTER_DEPARTURE', 'Напоминание должно быть раньше вылета', { remindAt: 'invalid' });
    if (input.remindEnabled && remindAt && remindAt <= now) throw unprocessable('REMIND_IN_PAST', 'Время напоминания уже прошло', { remindAt: 'past' });

    const result = await this.d.prisma.$transaction(async (tx) => {
      const lead = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id: leadId }) }), 'Лид');
      if (!canEditRecord(actor, lead.ownerId)) throw forbidden();
      if (lead.stage !== 'WON') throw unprocessable('LEAD_NOT_SOLD', 'Сначала поставьте статус «Продано»', { status: 'required' });
      const { LeadsService } = await import('./leads.service');
      const order = await new LeadsService(this.d).ensureOrderForWon(tx, actor.companyId, lead, now, actor);

      const data: Prisma.OrderUncheckedUpdateInput = { version: { increment: 1 } };
      // --- цены: та же логика валют, что и в карточке заказа; пустое поле = неизвестно (не 0) ---
      const pricing = input.amount !== undefined || input.netAmount !== undefined || (input.currency !== undefined && input.currency !== order.currency);
      if (pricing) {
        const currency = input.currency ?? order.currency;
        const anyAmount = (input.amount ?? null) !== null || (input.netAmount ?? null) !== null;
        if (anyAmount && (!currency || !isSupportedCurrency(currency))) throw unprocessable('INVALID_CURRENCY', 'Валюта не указана', { currency: 'required' });
        const keepsAmount = (input.amount === undefined && order.agreedAmountMinor !== null) || (input.netAmount === undefined && order.netPriceMinor !== null);
        if (order.currency && currency !== order.currency && keepsAmount) {
          throw unprocessable('CURRENCY_CHANGE_REQUIRES_AMOUNTS', 'При смене валюты цену продажи и себестоимость нужно ввести заново (пересчёт по курсу не выполняется)', { currency: 'requires_amounts' });
        }
        const parse = (v: string, field: string, label: string) => {
          const m = parseMoney(v, currency!);
          if (m.amountMinor < 0n) throw unprocessable('INVALID_AMOUNT', `${label} не может быть отрицательной`, { [field]: 'negative' });
          return m.amountMinor;
        };
        if (input.amount !== undefined) data.agreedAmountMinor = input.amount === null ? null : parse(input.amount, 'amount', 'Цена продажи');
        if (input.netAmount !== undefined) data.netPriceMinor = input.netAmount === null ? null : parse(input.netAmount, 'netAmount', 'Себестоимость');
        data.currency = currency ?? null;
      }
      // --- туроператор (из списка поставщиков) ---
      const operatorChanged = input.tourOperatorId !== undefined && input.tourOperatorId !== order.tourOperatorId;
      if (operatorChanged) {
        if (input.tourOperatorId) await assertSelectableSupplier(tx, actor.companyId, input.tourOperatorId, { kind: 'tour_operator' });
        data.tourOperatorId = input.tourOperatorId ?? null;
      }
      data.saleServiceType = input.serviceType;
      data.soldWhat = input.serviceType === 'other' ? input.soldWhat!.trim() : null;
      data.departureAt = departureAt;
      data.departureNote = input.departureNote?.trim() || null;
      data.remindEnabled = input.remindEnabled;
      data.remindAt = input.remindEnabled ? remindAt : null;
      data.remindTimezone = input.timezone;
      const after = await tx.order.update({ where: { id: order.id }, data });

      if (pricing) {
        await audit(tx, actor, {
          entityType: 'order',
          entityId: order.id,
          action: 'price_updated',
          oldValue: { agreedAmountMinor: order.agreedAmountMinor, netPriceMinor: order.netPriceMinor, currency: order.currency },
          newValue: { agreedAmountMinor: after.agreedAmountMinor, netPriceMinor: after.netPriceMinor, currency: after.currency, via: 'lead_sale' },
        });
      }
      if (operatorChanged) await audit(tx, actor, { entityType: 'order', entityId: order.id, action: 'tour_operator_changed', oldValue: { tourOperatorId: order.tourOperatorId }, newValue: { tourOperatorId: after.tourOperatorId, via: 'lead_sale' } });
      const snap = (o: Order) => ({ saleServiceType: o.saleServiceType, soldWhat: o.soldWhat, departureAt: o.departureAt, departureNote: o.departureNote, remindEnabled: o.remindEnabled, remindAt: o.remindAt, remindTimezone: o.remindTimezone });
      if (JSON.stringify(snap(order)) !== JSON.stringify(snap(after))) await audit(tx, actor, { entityType: 'order', entityId: order.id, action: 'sale_updated', oldValue: snap(order), newValue: snap(after) });
      await this.syncReminder(tx, actor, lead, after, now);
      return { lead, order: after };
    });
    await publishEvent(this.d.redis, { companyId: actor.companyId, entityType: 'lead', entityId: leadId, ownerId: result.lead.ownerId, kind: 'updated' });
    return this.view(actor, await this.d.prisma.lead.findUniqueOrThrow({ where: { id: leadId } }));
  }

  /**
   * Одно напоминание на (заказ, плановое время). Ключ строится от планового времени, поэтому повторное
   * сохранение без изменений ничего не создаёт, а уже отправленное напоминание не повторяется.
   */
  private async syncReminder(tx: Tx, actor: UserActor, lead: Lead, order: Order, now: Date) {
    const nominal = order.remindEnabled && order.departureAt ? (order.remindAt ?? new Date(order.departureAt.getTime() - REMIND_BEFORE_MS)) : null;
    const wanted = nominal && order.departureAt! > now ? `${KEY_PREFIX}${order.id}:${nominal.getTime()}` : null;
    const stale = await tx.reminderOccurrence.findMany({ where: { companyId: order.companyId, orderId: order.id, dedupeKey: { startsWith: KEY_PREFIX, ...(wanted ? { not: wanted } : {}) }, state: { in: [...ACTIVE] } }, select: { id: true } });
    if (stale.length) {
      const ids = stale.map((s) => s.id);
      await tx.reminderOccurrence.updateMany({ where: { id: { in: ids } }, data: { state: 'cancelled', cancelledAt: now, cancelReason: 'sale_changed', leaseUntil: null } });
      await tx.crmTask.updateMany({ where: { companyId: order.companyId, entityType: 'occurrence', entityId: { in: ids }, state: { in: ['pending', 'open'] } }, data: { state: 'cancelled' } });
    }
    if (!wanted || !nominal) return;
    const tz = order.remindTimezone ?? DEFAULT_REMINDER_TZ;
    const client = lead.name || 'клиент';
    const title = `Вылет ${formatInZone(order.departureAt!, tz)}: ${client}`;
    const body = [order.departureNote, `Часовой пояс: ${tz}`].filter(Boolean).join('\n');
    const dueAt = nominal > now ? nominal : now; // плановое время прошло (вылет скоро) — напомнить сразу
    const existing = await tx.reminderOccurrence.findUnique({ where: { companyId_dedupeKey: { companyId: order.companyId, dedupeKey: wanted } } });
    if (existing) {
      if (existing.state === 'cancelled') {
        await tx.reminderOccurrence.update({ where: { id: existing.id }, data: { state: 'scheduled', dueAt, cancelledAt: null, cancelReason: null, assigneeId: lead.ownerId, title, body, timezone: tz } });
      } else if ((ACTIVE as readonly string[]).includes(existing.state) && existing.state !== 'due') {
        await tx.reminderOccurrence.update({ where: { id: existing.id }, data: { assigneeId: lead.ownerId, title, body, timezone: tz } });
      }
      return;
    }
    const occ = await tx.reminderOccurrence.create({
      data: { companyId: order.companyId, kind: 'manual', orderId: order.id, dedupeKey: wanted, title, body, dueAt, assigneeId: lead.ownerId, createdById: actor.id, timezone: tz, escalateAfterMinutes: null },
    });
    await audit(tx, actor, { entityType: 'reminder', entityId: occ.id, action: 'created', newValue: { kind: 'departure', dueAt, timezone: tz, assigneeId: lead.ownerId, orderId: order.id } });
  }

  private async currentOccurrence(tx: Tx, order: Pick<Order, 'id' | 'companyId'>) {
    return tx.reminderOccurrence.findFirst({ where: { companyId: order.companyId, orderId: order.id, dedupeKey: { startsWith: KEY_PREFIX }, state: { notIn: ['cancelled', 'superseded'] } }, orderBy: { createdAt: 'desc' }, select: { state: true, dueAt: true } });
  }

  /** «Ближайшие вылеты»: 15 будущих вылетов по активным продажам, ближайшие первыми; область видимости — владелец лида. */
  async upcoming(actor: UserActor, limit = 15) {
    const now = this.d.clock.now();
    const orders = await this.d.prisma.order.findMany({
      where: { companyId: actor.companyId, ...ownerFilter(actor), departureAt: { gt: now }, fulfillmentState: { notIn: ['cancelled', 'completed'] } },
      orderBy: [{ departureAt: 'asc' }, { id: 'asc' }],
      take: limit * 2,
    });
    const leads = await this.d.prisma.lead.findMany({ where: { companyId: actor.companyId, id: { in: orders.map((o) => o.leadId) }, deletedAt: null, stage: 'WON' }, select: { id: true, name: true, contactId: true, ownerId: true } });
    const leadById = new Map(leads.map((l) => [l.id, l]));
    const rows = orders.filter((o) => leadById.has(o.leadId)).slice(0, limit);
    const [contacts, users, occs] = await Promise.all([
      this.d.prisma.contact.findMany({ where: { companyId: actor.companyId, id: { in: leads.map((l) => l.contactId) } }, select: { id: true, instagramUsername: true, fullName: true } }),
      this.d.prisma.user.findMany({ where: { companyId: actor.companyId, id: { in: rows.map((o) => o.ownerId).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } }),
      this.d.prisma.reminderOccurrence.findMany({ where: { companyId: actor.companyId, orderId: { in: rows.map((o) => o.id) }, dedupeKey: { startsWith: KEY_PREFIX }, state: { notIn: ['cancelled', 'superseded'] } }, orderBy: { createdAt: 'desc' }, select: { orderId: true, state: true, dueAt: true } }),
    ]);
    const contactById = new Map(contacts.map((c) => [c.id, c]));
    const userById = new Map(users.map((u) => [u.id, u.fullName]));
    return {
      items: rows.map((o) => {
        const lead = leadById.get(o.leadId)!;
        const c = contactById.get(lead.contactId);
        const occ = occs.find((x) => x.orderId === o.id) ?? null;
        return {
          orderId: o.id,
          leadId: o.leadId,
          client: c?.fullName || lead.name,
          instagramUsername: c?.instagramUsername ?? null,
          departureAt: o.departureAt,
          serviceType: o.saleServiceType,
          soldWhat: o.soldWhat,
          departureNote: o.departureNote,
          owner: o.ownerId ? (userById.get(o.ownerId) ?? null) : null,
          reminder: reminderView(o, occ, now),
        };
      }),
    };
  }
}
