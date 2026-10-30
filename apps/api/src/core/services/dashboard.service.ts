import { Prisma, type Channel, type Stage } from '@crm/database';
import {
  bucketKey,
  can,
  closedConversion,
  cohortConversion,
  companyDateRangeToUtc,
  firstResponseStats,
  FULFILLMENT_LABELS_RU,
  formatLocalRu,
  formatMoney,
  marginPercent,
  PAYMENT_LABELS_RU,
  percent,
  channelsOfSourceGroup,
  SERVICE_TYPE_LABELS_RU,
  sha256Hex,
  SOURCE_LABELS_RU,
  STAGE_LABELS_RU,
  stableStringify,
  summarizeFinance,
  sumByCurrency,
  wonInPeriod,
  workingMinutesBetween,
  type Bucket,
  type FinanceOrderInput,
  type LeadFact,
  type MoneyAgg,
  type WeeklySchedule,
} from '@crm/domain';
import { audit } from '../audit';
import type { CoreDeps, UserActor } from '../context';
import { unprocessable } from '../errors';
import { dashboardVersionKey } from '../events';
import { canCost, requireCap } from '../scope';
import { loadRefunds, orderFinance } from './orders.service';

export interface DashboardFilters {
  from: string;
  to: string;
  source?: Channel;
  ownerId?: string;
  serviceType?: string;
  stage?: Stage;
  departureFrom?: string;
  departureTo?: string;
  /** Turoperator (lidga biriktirilgan yetkazib beruvchi). */
  tourOperatorId?: string;
  /** «Только из рекламы» — faqat lidlar jadvali uchun. */
  fromAd?: 'true';
  /** Faqat shu valyutadagi summalar. */
  currency?: string;
  bucket: Bucket;
}

const moneyMap = (m: Record<string, bigint>) => Object.fromEntries(Object.entries(m).map(([c, v]) => [c, formatMoney({ amountMinor: v, currency: c })]));
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * KPI formulas exactly as TZ §15.1. Period metrics and current snapshots are labelled separately.
 * Managers see only their own figures; filters are applied in the backend.
 */
const inflight = new Map<string, Promise<unknown>>();

export class DashboardService {
  constructor(private readonly d: CoreDeps) {}

  private leadScope(actor: UserActor, f: DashboardFilters): Prisma.LeadWhereInput {
    const ownerId = can(actor.role, 'dashboard.company') ? f.ownerId : actor.id;
    return {
      companyId: actor.companyId,
      deletedAt: null,
      ...(ownerId ? { ownerId } : {}),
      ...(f.source ? { firstSource: f.source } : {}),
      ...(f.serviceType ? { serviceType: f.serviceType } : {}),
      ...(f.stage ? { stage: f.stage } : {}),
      ...(f.tourOperatorId ? { tourOperatorId: f.tourOperatorId } : {}),
    };
  }

  /** SQL scope for alias `l` (leads) — same rules as leadScope; used by aggregate queries. */
  private scopeSql(actor: UserActor, f: DashboardFilters, departure: { start: Date; end: Date } | null): Prisma.Sql {
    const ownerId = can(actor.role, 'dashboard.company') ? f.ownerId : actor.id;
    const parts: Prisma.Sql[] = [Prisma.sql`l.company_id = ${actor.companyId}::uuid`, Prisma.sql`l.deleted_at IS NULL`];
    if (ownerId) parts.push(Prisma.sql`l.owner_id = ${ownerId}::uuid`);
    if (f.source) parts.push(Prisma.sql`l.first_source = ${f.source}::"Channel"`);
    if (f.serviceType) parts.push(Prisma.sql`l.service_type = ${f.serviceType}`);
    if (f.stage) parts.push(Prisma.sql`l.stage = ${f.stage}::"Stage"`);
    if (f.tourOperatorId) parts.push(Prisma.sql`l.tour_operator_id = ${f.tourOperatorId}::uuid`);
    if (departure) {
      parts.push(Prisma.sql`EXISTS (SELECT 1 FROM orders o JOIN flight_segments s ON s.order_id = o.id WHERE o.lead_id = l.id AND s.active AND s.departure_at_utc >= ${departure.start} AND s.departure_at_utc < ${departure.end})`);
    }
    return Prisma.join(parts, ' AND ');
  }

  /** Short Redis cache per scope+filters; the payload carries generatedAt so staleness is visible. */
  async compute(actor: UserActor, f: DashboardFilters) {
    const scopeKey = `${can(actor.role, 'dashboard.company') ? 'company' : `user:${actor.id}`}:cost${canCost(actor) ? 1 : 0}`;
    const ver = (await this.d.redis.get(dashboardVersionKey(actor.companyId)).catch(() => null)) ?? '0';
    const key = `dash:${actor.companyId}:${ver}:${scopeKey}:${sha256Hex(stableStringify(f))}`;
    const cached = await this.d.redis.get(key).catch(() => null);
    if (cached) return JSON.parse(cached) as Awaited<ReturnType<DashboardService['computeFresh']>>;
    // Single-flight: concurrent identical requests share one computation (no cache stampede).
    const running = inflight.get(key);
    if (running) return running as ReturnType<DashboardService['computeFresh']>;
    const job = this.computeFresh(actor, f)
      .then(async (fresh) => {
        await this.d.redis.set(key, JSON.stringify(fresh), 'EX', 20).catch(() => undefined);
        return fresh;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  /**
   * Dashboard filtrlariga mos lidlar jadvali: lid YARATILGAN sana bo'yicha (Asia/Tashkent, boshlanish va tugash kunlari to'liq kiradi),
   * ko'rinish doirasi `leadScope` (menejer — faqat o'zinikini). Moliya ko'rsatkichlari hisoblash qoidalariga tegilmaydi.
   */
  async listLeads(actor: UserActor, f: DashboardFilters, limit = 200) {
    const company = await this.d.prisma.company.findUniqueOrThrow({ where: { id: actor.companyId } });
    if (f.from > f.to) throw unprocessable('DATE_RANGE_INVALID', 'Дата начала не может быть позже даты окончания', { from: 'after_to' });
    const { start, end } = companyDateRangeToUtc(f.from, f.to, company.timezone);
    const where: Prisma.LeadWhereInput = { ...this.leadScope(actor, f), createdAt: { gte: start, lt: end }, ...(f.fromAd ? { OR: [{ adReferralAt: { not: null } }, { firstSource: { in: channelsOfSourceGroup('ADS') as Channel[] } }] } : {}) };
    const [total, rows] = await Promise.all([this.d.prisma.lead.count({ where }), this.d.prisma.lead.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, select: { id: true, name: true, stage: true, firstSource: true, ownerId: true, createdAt: true, contactId: true, adReferralAt: true } })]);
    const contacts = await this.d.prisma.contact.findMany({ where: { companyId: actor.companyId, id: { in: [...new Set(rows.map((r) => r.contactId))] } }, select: { id: true, fullName: true, instagramUsername: true, telegramUsername: true } });
    const byId = new Map(contacts.map((c) => [c.id, c]));
    return {
      total,
      truncated: total > rows.length,
      range: { from: f.from, to: f.to, timezone: company.timezone },
      items: rows.map((r) => ({ id: r.id, name: r.name, stage: r.stage, source: r.firstSource, ownerId: r.ownerId, createdAt: r.createdAt, fromAd: !!r.adReferralAt, contactName: byId.get(r.contactId)?.fullName ?? null, instagramUsername: byId.get(r.contactId)?.instagramUsername ?? null, telegramUsername: byId.get(r.contactId)?.telegramUsername ?? null })),
    };
  }

  async computeFresh(actor: UserActor, f: DashboardFilters) {
    const company = await this.d.prisma.company.findUniqueOrThrow({ where: { id: actor.companyId } });
    const { start, end } = companyDateRangeToUtc(f.from, f.to, company.timezone);
    const departure = f.departureFrom && f.departureTo ? companyDateRangeToUtc(f.departureFrom, f.departureTo, company.timezone) : null;
    const scope = this.leadScope(actor, f);
    if (departure) scope.orders = { some: { segments: { some: { active: true, departureAtUtc: { gte: departure.start, lt: departure.end } } } } };
    const where = this.scopeSql(actor, f, departure);
    const q = <T>(sql: Prisma.Sql) => this.d.prisma.$queryRaw<T[]>(sql);

    // Leads relevant for the period: created, closed or first won in the period.
    const leads = await q<{ id: string; createdAt: Date; stage: string; firstWonAt: Date | null; firstSource: string; firstHumanActionAt: Date | null; ownerId: string | null; tourOperatorId: string | null }>(Prisma.sql`
      SELECT l.id, l.created_at AS "createdAt", l.stage::text AS stage, l.first_won_at AS "firstWonAt", l.first_source::text AS "firstSource",
             l.first_human_action_at AS "firstHumanActionAt", l.owner_id AS "ownerId", l.tour_operator_id AS "tourOperatorId"
      FROM leads l
      WHERE ${where} AND ((l.created_at >= ${start} AND l.created_at < ${end}) OR (l.closed_at >= ${start} AND l.closed_at < ${end}) OR (l.first_won_at >= ${start} AND l.first_won_at < ${end}))`);
    const leadIds = leads.map((l) => l.id);
    const [closeEvents, humanEvents] = leadIds.length
      ? await Promise.all([
          q<{ leadId: string; newStage: string; effectiveAt: Date }>(Prisma.sql`
            SELECT lead_id AS "leadId", new_stage::text AS "newStage", effective_at AS "effectiveAt" FROM lead_events
            WHERE company_id = ${actor.companyId}::uuid AND lead_id = ANY(${leadIds}::uuid[]) AND new_stage IN ('WON', 'LOST')`),
          q<{ leadId: string }>(Prisma.sql`
            SELECT DISTINCT lead_id AS "leadId" FROM lead_events
            WHERE company_id = ${actor.companyId}::uuid AND lead_id = ANY(${leadIds}::uuid[]) AND actor_id IS NOT NULL`),
        ])
      : [[], []];
    const humanSet = new Set(humanEvents.map((e) => e.leadId));
    const closesByLead = new Map<string, Array<{ stage: 'WON' | 'LOST'; at: Date }>>();
    for (const e of closeEvents) {
      const list = closesByLead.get(e.leadId) ?? [];
      list.push({ stage: e.newStage as 'WON' | 'LOST', at: e.effectiveAt });
      closesByLead.set(e.leadId, list);
    }
    const leadById = new Map(leads.map((l) => [l.id, l]));

    const facts: LeadFact[] = leads.map((l) => ({ id: l.id, createdAt: l.createdAt, stage: l.stage, firstWonAt: l.firstWonAt, closes: closesByLead.get(l.id) ?? [] }));
    const inRange = (d: Date | null) => !!d && d >= start && d < end;
    const cohort = leads.filter((l) => inRange(l.createdAt));

    const bySource: Record<string, number> = {};
    for (const l of cohort) bySource[l.firstSource] = (bySource[l.firstSource] ?? 0) + 1;
    const adsLeads = (bySource.instagram_lead_ads ?? 0) + (bySource.meta_lead_ads ?? 0);
    const directLeads = bySource.instagram_direct ?? 0;
    const companyWide = can(actor.role, 'dashboard.company') && !f.ownerId && !f.serviceType && !f.stage && !departure;

    const wonIds = leads.filter((l) => inRange(l.firstWonAt)).map((l) => l.id);
    const [inquiryRows, inProgress, awaitingRows, cancelledOrders, paymentRows, convs, ownerEvents] = await Promise.all([
      companyWide
        ? q<{ n: bigint }>(Prisma.sql`SELECT count(*)::bigint AS n FROM inquiries i WHERE i.company_id = ${actor.companyId}::uuid AND i.received_at >= ${start} AND i.received_at < ${end} ${f.source ? Prisma.sql`AND i.channel = ${f.source}::"Channel"` : Prisma.empty}`)
        : q<{ n: bigint }>(Prisma.sql`SELECT count(*)::bigint AS n FROM inquiries i JOIN leads l ON l.id = i.lead_id WHERE ${where} AND i.received_at >= ${start} AND i.received_at < ${end} ${f.source ? Prisma.sql`AND i.channel = ${f.source}::"Channel"` : Prisma.empty}`),
      this.d.prisma.lead.count({ where: { ...scope, stage: { notIn: ['WON', 'LOST'] } } }),
      q<{ n: bigint }>(Prisma.sql`
        SELECT count(*)::bigint AS n FROM conversations c JOIN leads l ON l.id = c.lead_id
        WHERE ${where} AND l.stage NOT IN ('WON', 'LOST') AND c.last_inbound_at IS NOT NULL AND (c.last_human_reply_at IS NULL OR c.last_human_reply_at < c.last_inbound_at)`),
      q<{ n: bigint }>(Prisma.sql`SELECT count(*)::bigint AS n FROM orders o JOIN leads l ON l.id = o.lead_id WHERE ${where} AND o.fulfillment_state = 'cancelled' AND o.cancelled_at >= ${start} AND o.cancelled_at < ${end}`),
      q<{ kind: string; currency: string; total: bigint }>(Prisma.sql`
        SELECT p.kind, p.currency, sum(p.amount_minor)::bigint AS total FROM payments p JOIN orders o ON o.id = p.order_id JOIN leads l ON l.id = o.lead_id
        WHERE ${where} AND p.status = 'confirmed' AND p.received_at >= ${start} AND p.received_at < ${end} GROUP BY p.kind, p.currency`),
      q<{ firstInboundAt: Date; firstHumanReplyAt: Date | null }>(Prisma.sql`
        SELECT c.first_inbound_at AS "firstInboundAt", c.first_human_reply_at AS "firstHumanReplyAt" FROM conversations c JOIN leads l ON l.id = c.lead_id
        WHERE ${where} AND c.first_inbound_at >= ${start} AND c.first_inbound_at < ${end}`),
      wonIds.length
        ? this.d.prisma.leadEvent.findMany({ where: { companyId: actor.companyId, leadId: { in: wonIds }, newOwnerId: { not: null } }, select: { leadId: true, newOwnerId: true, effectiveAt: true }, orderBy: { effectiveAt: 'asc' } })
        : Promise.resolve([]),
    ]);
    const inquiries = Number(inquiryRows[0]?.n ?? 0);
    const awaiting = [{ n: awaitingRows[0]?.n ?? 0n }];
    const lostCount = new Set(closeEvents.filter((e) => e.newStage === 'LOST' && inRange(e.effectiveAt) && leadById.get(e.leadId)?.stage === 'LOST').map((e) => e.leadId)).size;
    const payments = paymentRows.filter((r) => !f.currency || r.currency === f.currency).map((r) => ({ kind: r.kind, amountMinor: BigInt(r.total), currency: r.currency }));
    const ownerEventsByLead = new Map<string, Array<{ newOwnerId: string | null; effectiveAt: Date }>>();
    for (const e of ownerEvents) ownerEventsByLead.set(e.leadId, [...(ownerEventsByLead.get(e.leadId) ?? []), e]);
    const fr = firstResponseStats(convs.map((c) => ({ firstInboundAt: c.firstInboundAt, firstHumanReplyAt: c.firstHumanReplyAt })));
    const schedule = company.workSchedule as unknown as WeeklySchedule;
    const slaMinutes = convs.filter((c) => c.firstHumanReplyAt).map((c) => workingMinutesBetween(schedule, c.firstInboundAt, c.firstHumanReplyAt!));
    const cancelledOrdersCount = Number(cancelledOrders[0]?.n ?? 0);

    // Manager results: current owner for workload, owner at close time for historical sales.
    const ownerAt = (leadId: string, at: Date) => {
      let owner: string | null = null;
      for (const e of ownerEventsByLead.get(leadId) ?? []) if (e.effectiveAt <= at) owner = e.newOwnerId;
      return owner;
    };

    // ---- Moliya (tannarx / sotuv / foyda). Qoidalar: docs/tz-addendum-finance.md ----
    // confirmed: davrda birinchi marta WON bo'lgan lidlarning bekor qilinmagan buyurtmalari (qaytarimlari bo'lsa ham).
    // open: hali yopilmagan lidlarning bekor qilinmagan buyurtmalari (kutilayotgan foyda, davrga bog'lanmagan snapshot).
    // cancelled: davrda bekor qilingan buyurtmalar (tarixiy summa saqlanadi, jami sotuvga kirmaydi).
    // Turoperator — BUYURTMANING tarixiy bog'lanishi (lid keyin o'zgarsa ham statistika o'zgarmaydi), shuning uchun
    // turoperator filtri bu yerda lidga emas, buyurtmaga qo'llanadi.
    const cost = canCost(actor);
    const noOp = { ...f, tourOperatorId: undefined };
    const scopeNoOp = this.leadScope(actor, noOp);
    if (departure) scopeNoOp.orders = { some: { segments: { some: { active: true, departureAtUtc: { gte: departure.start, lt: departure.end } } } } };
    const whereNoOp = this.scopeSql(actor, noOp, departure);
    const finLeads = await q<{ id: string; firstWonAt: Date; ownerId: string | null }>(Prisma.sql`
      SELECT l.id, l.first_won_at AS "firstWonAt", l.owner_id AS "ownerId" FROM leads l
      WHERE ${whereNoOp} AND l.first_won_at >= ${start} AND l.first_won_at < ${end}`);
    const finLeadById = new Map(finLeads.map((l) => [l.id, l]));
    const orderOp = f.tourOperatorId ? { tourOperatorId: f.tourOperatorId } : {};
    const svcInclude = { services: { where: { removedAt: null } } } as const;
    const [wonOrders, cancelledRows, openRows, finOwnerEvents] = await Promise.all([
      finLeads.length ? this.d.prisma.order.findMany({ where: { companyId: actor.companyId, leadId: { in: finLeads.map((l) => l.id) }, fulfillmentState: { not: 'cancelled' }, ...orderOp }, include: svcInclude }) : Promise.resolve([]),
      this.d.prisma.order.findMany({ where: { companyId: actor.companyId, fulfillmentState: 'cancelled', cancelledAt: { gte: start, lt: end }, lead: scopeNoOp, ...orderOp }, include: svcInclude }),
      this.d.prisma.order.findMany({ where: { companyId: actor.companyId, fulfillmentState: { not: 'cancelled' }, lead: { AND: [scopeNoOp, { stage: { notIn: ['WON', 'LOST'] } }] }, ...orderOp }, include: svcInclude }),
      finLeads.length ? this.d.prisma.leadEvent.findMany({ where: { companyId: actor.companyId, leadId: { in: finLeads.map((l) => l.id) }, newOwnerId: { not: null } }, select: { leadId: true, newOwnerId: true, effectiveAt: true }, orderBy: { effectiveAt: 'asc' } }) : Promise.resolve([]),
    ]);
    const finOwnerByLead = new Map<string, Array<{ newOwnerId: string | null; effectiveAt: Date }>>();
    for (const e of finOwnerEvents) finOwnerByLead.set(e.leadId, [...(finOwnerByLead.get(e.leadId) ?? []), e]);
    const finOwnerAt = (leadId: string, at: Date) => {
      let owner: string | null = null;
      for (const e of finOwnerByLead.get(leadId) ?? []) if (e.effectiveAt <= at) owner = e.newOwnerId;
      return owner;
    };
    const refundMap = await loadRefunds(this.d.prisma, actor.companyId, wonOrders.map((o) => o.id));
    const financeInputs: FinanceOrderInput[] = [];
    for (const o of wonOrders) {
      const fl = finLeadById.get(o.leadId);
      financeInputs.push({
        orderId: o.id,
        bucket: 'confirmed',
        finance: orderFinance(o, o.services, refundMap.get(o.id)?.refunds ?? {}),
        managerId: (fl ? finOwnerAt(o.leadId, fl.firstWonAt) : null) ?? fl?.ownerId ?? o.ownerId,
        operatorId: o.tourOperatorId,
      });
    }
    for (const o of cancelledRows) financeInputs.push({ orderId: o.id, bucket: 'cancelled', finance: orderFinance(o, o.services), managerId: o.ownerId, operatorId: o.tourOperatorId });
    for (const o of openRows) financeInputs.push({ orderId: o.id, bucket: 'open', finance: orderFinance(o, o.services), managerId: o.ownerId, operatorId: o.tourOperatorId });
    const finance = summarizeFinance(financeInputs, f.currency ? { currency: f.currency } : {});
    const salesByCurrency = Object.fromEntries(Object.entries(finance.confirmed).map(([c, a]) => [c, a.sales]));
    const operatorNames = new Map(
      (await this.d.prisma.supplier.findMany({ where: { companyId: actor.companyId, id: { in: finance.byOperator.map((r) => r.operatorId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]),
    );
    const aggOut = (a: MoneyAgg, c: string) => {
      const mon = (x: bigint) => formatMoney({ amountMinor: x, currency: c });
      const base = { sales: mon(a.sales), customerRefunded: mon(a.customerRefunded), ordersWithRefund: a.ordersWithRefund };
      if (!cost) return base; // tannarx, foyda va yetkazib beruvchi qaytarimlari huquqsiz foydalanuvchiga chiqmaydi
      return {
        ...base,
        supplierRefunded: mon(a.supplierRefunded),
        /** Dastlabki foyda (qaytarimsiz), tannarxi aniq buyurtmalar bo'yicha. */
        profitBasis: { sales: mon(a.basisSales), net: mon(a.basisNet), profit: mon(a.profit), orders: a.basisOrders, marginPercent: marginPercent(a.basisSales, a.profit) },
        /** Qaytarimdan keyingi: (sotuv − mijozga qaytarilgan) va (tannarx − yetkazib beruvchidan qaytgan). */
        afterRefund: { sales: mon(a.basisSalesAfterRefund), net: mon(a.basisNetAfterRefund), profit: mon(a.profitAfterRefund), marginPercent: marginPercent(a.basisSalesAfterRefund, a.profitAfterRefund) },
        undetermined: { orders: a.undeterminedOrders, sales: mon(a.undeterminedSales) },
      };
    };
    const aggMap = (m2: Record<string, MoneyAgg>) => Object.fromEntries(Object.entries(m2).map(([c, a]) => [c, aggOut(a, c)]));
    const userNames = new Map((await this.d.prisma.user.findMany({ where: { companyId: actor.companyId }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const rulesAll = {
      confirmed: "Подтверждённая продажа: неотменённые заказы лидов, впервые получивших этап «Продажа завершена» в периоде (даже если по ним были возвраты).",
      cancelled: "Отменённые заказы не входят в итоговые продажи и прибыль; их суммы сохраняются в истории и показываются отдельно.",
      operator: "Туроператор — историческая связь заказа: если туроператор лида позже изменится, статистика прошлых продаж не меняется; смена туроператора заказа выполняется отдельно, с причиной и записью в журнале.",
      currencies: "Валюты не складываются без курса: каждая валюта считается отдельно.",
    };
    const rulesCost = {
      formula: "Первоначальная прибыль = цена продажи − себестоимость. Прибыль после возвратов = (продажа − возвращено клиенту) − (себестоимость − возвращено поставщиком). Дополнительные расходы (комиссии, налоги, банковские платежи, курсовая разница) не учтены: это не итоговая «чистая прибыль» по бухгалтерии.",
      refunds: "Возвраты клиенту и суммы, вернувшиеся от поставщика, записываются отдельно; их валюта должна совпадать с валютой цен заказа. Возврат не меняет первоначальную прибыль — он отражается в «прибыли после возвратов».",
      unknownNet: "Заказ без указанной себестоимости не считается за 0: прибыль «не определена», их количество показано отдельно, в итог себестоимости и прибыли они не входят.",
      expected: "Ожидаемая прибыль: открытые заказы ещё не закрытых лидов (с известной себестоимостью). Это не подтверждённая прибыль.",
    };
    const financeOut = {
      costHidden: !cost,
      rules: cost ? { ...rulesAll, ...rulesCost } : rulesAll,
      confirmed: aggMap(finance.confirmed),
      undeterminedOrders: cost ? finance.undeterminedOrders : null,
      unpricedOrders: finance.unpricedOrders,
      refundMismatchOrders: cost ? finance.refundMismatchOrders : null,
      expected: cost ? Object.fromEntries(Object.entries(finance.expected).map(([c, e]) => [c, { profit: formatMoney({ amountMinor: e.profit, currency: c }), orders: e.orders, undeterminedOrders: e.undeterminedOrders }])) : {},
      cancelled: Object.fromEntries(Object.entries(finance.cancelled).map(([c, e]) => [c, { sales: formatMoney({ amountMinor: e.sales, currency: c }), orders: e.orders }])),
      byOperator: finance.byOperator
        .map((r) => ({ operatorId: r.operatorId, name: r.operatorId ? (operatorNames.get(r.operatorId) ?? '—') : 'Не указан', orders: r.orders, undeterminedOrders: cost ? r.undeterminedOrders : null, currencies: aggMap(r.currencies) }))
        .sort((a, b) => b.orders - a.orders),
      byManager: finance.byManager
        .map((r) => ({ userId: r.managerId, name: r.managerId ? (userNames.get(r.managerId) ?? '—') : 'Не назначен', orders: r.orders, undeterminedOrders: cost ? r.undeterminedOrders : null, currencies: aggMap(r.currencies) }))
        .sort((a, b) => b.orders - a.orders),
    };
    const managers: Record<string, { newLeads: number; won: number; inProgress: number; sales: Record<string, bigint> }> = {};
    const m = (id: string | null) => (managers[id ?? 'unassigned'] ??= { newLeads: 0, won: 0, inProgress: 0, sales: {} });
    for (const l of cohort) m(l.ownerId).newLeads++;
    for (const l of leads.filter((x) => inRange(x.firstWonAt))) {
      const owner = ownerAt(l.id, l.firstWonAt!) ?? l.ownerId;
      m(owner).won++;
    }
    for (const row of finance.byManager) {
      const target = m(row.managerId);
      for (const [c, agg] of Object.entries(row.currencies)) target.sales[c] = (target.sales[c] ?? 0n) + agg.sales;
    }
    const openByOwner = await this.d.prisma.lead.groupBy({ by: ['ownerId'], where: { ...scope, stage: { notIn: ['WON', 'LOST'] } }, _count: true });
    for (const g of openByOwner) m(g.ownerId).inProgress = g._count;
    const users = await this.d.prisma.user.findMany({ where: { companyId: actor.companyId }, select: { id: true, fullName: true } });

    const series: Record<string, { newLeads: number; won: number }> = {};
    for (const l of cohort) (series[bucketKey(l.createdAt, f.bucket, company.timezone)] ??= { newLeads: 0, won: 0 }).newLeads++;
    for (const l of leads.filter((x) => inRange(x.firstWonAt))) (series[bucketKey(l.firstWonAt!, f.bucket, company.timezone)] ??= { newLeads: 0, won: 0 }).won++;

    const funnelRows = await this.d.prisma.lead.groupBy({ by: ['stage'], where: scope, _count: true });
    const connections = await this.d.prisma.integrationConnection.findMany({ where: { companyId: actor.companyId }, select: { provider: true, health: true, lastSyncAt: true, lastWebhookAt: true } });
    const lastSync = connections.map((c) => c.lastSyncAt).filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const stale = connections.some((c) => c.health !== 'ok');

    return {
      period: { from: f.from, to: f.to, startUtc: start.toISOString(), endUtcExclusive: end.toISOString(), timezone: company.timezone },
      periodMetrics: {
        newLeads: cohort.length,
        inquiries,
        adsLeads,
        directLeads,
        bySource,
        processed: cohort.filter((l) => l.firstHumanActionAt || humanSet.has(l.id)).length,
        won: wonInPeriod(facts, start, end),
        lost: lostCount,
        cancelledOrders: cancelledOrdersCount,
        slaBreaches: cohort.length ? Number((await q<{ n: bigint }>(Prisma.sql`SELECT count(*)::bigint AS n FROM leads l WHERE ${where} AND l.sla_breached_at >= ${start} AND l.sla_breached_at < ${end}`))[0]?.n ?? 0) : 0,
        cohortConversion: cohortConversion(facts, start, end),
        closedConversion: closedConversion(facts, start, end),
        salesByCurrency: moneyMap(salesByCurrency),
        paymentsByCurrency: moneyMap(sumByCurrency(payments.filter((p) => p.kind === 'payment').map((p) => ({ amountMinor: p.amountMinor, currency: p.currency })))),
        refundsByCurrency: moneyMap(sumByCurrency(payments.filter((p) => p.kind === 'refund').map((p) => ({ amountMinor: p.amountMinor, currency: p.currency })))),
        firstResponse: { ...fr, slaWorkingMinutesMedian: median(slaMinutes) },
      },
      snapshot: { inProgress, awaitingReply: Number(awaiting[0]?.n ?? 0), asOf: this.d.clock.now().toISOString() },
      generatedAt: this.d.clock.now().toISOString(),
      cacheTtlSeconds: 20,
      funnel: Object.fromEntries(funnelRows.map((r) => [r.stage, r._count])),
      series: Object.entries(series).sort(([a], [b]) => a.localeCompare(b)).map(([bucket, v]) => ({ bucket, ...v })),
      managers: Object.entries(managers).map(([id, v]) => ({
        userId: id === 'unassigned' ? null : id,
        name: users.find((u) => u.id === id)?.fullName ?? 'Не назначен',
        newLeads: v.newLeads,
        won: v.won,
        inProgress: v.inProgress,
        conversion: percent(v.won, v.newLeads),
        salesByCurrency: moneyMap(v.sales),
      })),
      finance: financeOut,
      notes: {
        managerAttribution: 'Текущая нагрузка — по нынешнему ответственному; исторические продажи — по ответственному на момент закрытия.',
        sourceMode: 'Источник — первый зафиксированный источник лида.',
        currency: 'Валюты отдельно; общая сумма без источника курса не считается. Сумма продаж — это не прибыль.',
      },
      dataQuality: { dataCollectionStartedAt: company.dataCollectionStartedAt.toISOString(), lastSyncAt: lastSync?.toISOString() ?? null, stale },
    };
  }

  /**
   * Buyurtmalar CSV: faqat `export` huquqi (rahbar/administrator). Tannarx, foyda va qaytarim ustunlari qo'shimcha
   * `finance.cost.view` huquqini talab qiladi (bo'lmasa shu ustunlar chiqarilmaydi). Har bir (buyurtma, valyuta) uchun
   * bitta qator; foyda aniqlanmagan bo'lsa bo'sh (0 emas) va `profit_state=undetermined`. Auditga yoziladi.
   */
  async exportOrdersCsv(actor: UserActor, f: DashboardFilters): Promise<string> {
    requireCap(actor, 'export');
    const cost = canCost(actor);
    const company = await this.d.prisma.company.findUniqueOrThrow({ where: { id: actor.companyId } });
    const { start, end } = companyDateRangeToUtc(f.from, f.to, company.timezone);
    const rows = await this.d.prisma.order.findMany({
      where: { companyId: actor.companyId, createdAt: { gte: start, lt: end }, lead: this.leadScope(actor, { ...f, tourOperatorId: undefined }), ...(f.tourOperatorId ? { tourOperatorId: f.tourOperatorId } : {}) },
      include: { services: { where: { removedAt: null } }, lead: { select: { name: true, stage: true } } },
      orderBy: { createdAt: 'asc' },
      take: 50_000,
    });
    const refundMap = cost ? await loadRefunds(this.d.prisma, actor.companyId, rows.map((o) => o.id)) : new Map();
    const users = new Map((await this.d.prisma.user.findMany({ where: { companyId: actor.companyId }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const ops = new Map((await this.d.prisma.supplier.findMany({ where: { companyId: actor.companyId }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const header = ['Номер заказа', 'Лид', 'Этап лида', 'Ответственный', 'Туроператор', 'Статус заказа', 'Оплата', 'Валюта', 'Цена продажи', ...(cost ? ['Себестоимость', 'Первоначальная прибыль', 'Состояние прибыли', 'Возвращено клиенту', 'Возвращено поставщиком', 'Прибыль после возвратов'] : []), 'Создан'];
    const lines: string[] = [];
    for (const o of rows) {
      const fin = orderFinance(o, o.services, refundMap.get(o.id)?.refunds ?? {});
      const ccys = Object.values(fin.byCurrency).filter((c) => !f.currency || c.currency === f.currency);
      for (const c of ccys.length ? ccys : f.currency ? [] : [null]) {
        const mon = (x: bigint | null) => (x === null || !c ? '' : formatMoney({ amountMinor: x, currency: c.currency }));
        const cells = [
          o.orderNo,
          o.lead.name,
          STAGE_LABELS_RU[o.lead.stage],
          o.ownerId ? users.get(o.ownerId) : '',
          o.tourOperatorId ? ops.get(o.tourOperatorId) : '',
          FULFILLMENT_LABELS_RU[o.fulfillmentState] ?? o.fulfillmentState,
          PAYMENT_LABELS_RU[o.paymentState] ?? o.paymentState,
          c?.currency ?? '',
          c ? mon(c.sellingMinor) : '',
          ...(cost ? [c && c.lines - c.missingNetLines > 0 ? mon(c.netMinor) : '', c ? mon(c.profitMinor) : '', c && c.profitState === 'known' ? 'определена' : 'не определена', c ? mon(c.customerRefundedMinor) : '', c ? mon(c.supplierRefundedMinor) : '', c ? mon(c.profitAfterRefundMinor) : ''] : []),
          formatLocalRu(o.createdAt, company.timezone),
        ];
        lines.push(cells.map(esc).join(','));
      }
    }
    await audit(this.d.prisma, actor, { entityType: 'export', entityId: actor.companyId, action: 'orders_csv', newValue: { filters: f, rows: lines.length, costColumns: cost } });
    return [header.join(','), ...lines].join('\n');
  }

  /** CSV export of leads; requires the export capability, scoped and audited (TZ §6.1, AC12). */
  async exportLeadsCsv(actor: UserActor, f: DashboardFilters): Promise<string> {
    requireCap(actor, 'export');
    const company = await this.d.prisma.company.findUniqueOrThrow({ where: { id: actor.companyId } });
    const { start, end } = companyDateRangeToUtc(f.from, f.to, company.timezone);
    const rows = await this.d.prisma.lead.findMany({ where: { ...this.leadScope(actor, f), createdAt: { gte: start, lt: end } }, orderBy: { createdAt: 'asc' }, take: 50_000 });
    const users = new Map((await this.d.prisma.user.findMany({ where: { companyId: actor.companyId }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const zone = company.timezone;
    const header = ['ID', 'Название', 'Этап', 'Ответственный', 'Источник', 'Тип услуги', 'Создан', 'Закрыт'];
    const lines = rows.map((r) => [r.id, r.name, STAGE_LABELS_RU[r.stage], r.ownerId ? users.get(r.ownerId) : '', SOURCE_LABELS_RU[r.firstSource] ?? r.firstSource, r.serviceType ? (SERVICE_TYPE_LABELS_RU[r.serviceType] ?? r.serviceType) : '', formatLocalRu(r.createdAt, zone), r.closedAt ? formatLocalRu(r.closedAt, zone) : ''].map(esc).join(','));
    await audit(this.d.prisma, actor, { entityType: 'export', entityId: actor.companyId, action: 'leads_csv', newValue: { filters: f, rows: rows.length } });
    return [header.join(','), ...lines].join('\n');
  }
}
