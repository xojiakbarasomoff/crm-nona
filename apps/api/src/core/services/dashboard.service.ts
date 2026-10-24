import { Prisma, type Channel, type Stage } from '@crm/database';
import {
  bucketKey,
  can,
  closedConversion,
  cohortConversion,
  companyDateRangeToUtc,
  firstResponseStats,
  formatMoney,
  percent,
  sha256Hex,
  stableStringify,
  sumByCurrency,
  wonInPeriod,
  workingMinutesBetween,
  type Bucket,
  type LeadFact,
  type WeeklySchedule,
} from '@crm/domain';
import { audit } from '../audit';
import type { CoreDeps, UserActor } from '../context';
import { requireCap } from '../scope';

export interface DashboardFilters {
  from: string;
  to: string;
  source?: Channel;
  ownerId?: string;
  serviceType?: string;
  stage?: Stage;
  departureFrom?: string;
  departureTo?: string;
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
    if (departure) {
      parts.push(Prisma.sql`EXISTS (SELECT 1 FROM orders o JOIN flight_segments s ON s.order_id = o.id WHERE o.lead_id = l.id AND s.active AND s.departure_at_utc >= ${departure.start} AND s.departure_at_utc < ${departure.end})`);
    }
    return Prisma.join(parts, ' AND ');
  }

  /** Short Redis cache per scope+filters; the payload carries generatedAt so staleness is visible. */
  async compute(actor: UserActor, f: DashboardFilters) {
    const scopeKey = can(actor.role, 'dashboard.company') ? 'company' : `user:${actor.id}`;
    const key = `dash:${actor.companyId}:${scopeKey}:${sha256Hex(stableStringify(f))}`;
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

  async computeFresh(actor: UserActor, f: DashboardFilters) {
    const company = await this.d.prisma.company.findUniqueOrThrow({ where: { id: actor.companyId } });
    const { start, end } = companyDateRangeToUtc(f.from, f.to, company.timezone);
    const departure = f.departureFrom && f.departureTo ? companyDateRangeToUtc(f.departureFrom, f.departureTo, company.timezone) : null;
    const scope = this.leadScope(actor, f);
    if (departure) scope.orders = { some: { segments: { some: { active: true, departureAtUtc: { gte: departure.start, lt: departure.end } } } } };
    const where = this.scopeSql(actor, f, departure);
    const q = <T>(sql: Prisma.Sql) => this.d.prisma.$queryRaw<T[]>(sql);

    // Leads relevant for the period: created, closed or first won in the period.
    const leads = await q<{ id: string; createdAt: Date; stage: string; firstWonAt: Date | null; firstSource: string; firstHumanActionAt: Date | null; ownerId: string | null }>(Prisma.sql`
      SELECT l.id, l.created_at AS "createdAt", l.stage::text AS stage, l.first_won_at AS "firstWonAt", l.first_source::text AS "firstSource",
             l.first_human_action_at AS "firstHumanActionAt", l.owner_id AS "ownerId"
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
    const [inquiryRows, inProgress, awaitingRows, cancelledOrders, wonOrders, paymentRows, convs, ownerEvents] = await Promise.all([
      companyWide
        ? q<{ n: bigint }>(Prisma.sql`SELECT count(*)::bigint AS n FROM inquiries i WHERE i.company_id = ${actor.companyId}::uuid AND i.received_at >= ${start} AND i.received_at < ${end} ${f.source ? Prisma.sql`AND i.channel = ${f.source}::"Channel"` : Prisma.empty}`)
        : q<{ n: bigint }>(Prisma.sql`SELECT count(*)::bigint AS n FROM inquiries i JOIN leads l ON l.id = i.lead_id WHERE ${where} AND i.received_at >= ${start} AND i.received_at < ${end} ${f.source ? Prisma.sql`AND i.channel = ${f.source}::"Channel"` : Prisma.empty}`),
      this.d.prisma.lead.count({ where: { ...scope, stage: { notIn: ['WON', 'LOST'] } } }),
      q<{ n: bigint }>(Prisma.sql`
        SELECT count(*)::bigint AS n FROM conversations c JOIN leads l ON l.id = c.lead_id
        WHERE ${where} AND l.stage NOT IN ('WON', 'LOST') AND c.last_inbound_at IS NOT NULL AND (c.last_human_reply_at IS NULL OR c.last_human_reply_at < c.last_inbound_at)`),
      q<{ n: bigint }>(Prisma.sql`SELECT count(*)::bigint AS n FROM orders o JOIN leads l ON l.id = o.lead_id WHERE ${where} AND o.fulfillment_state = 'cancelled' AND o.cancelled_at >= ${start} AND o.cancelled_at < ${end}`),
      wonIds.length
        ? this.d.prisma.order.findMany({ where: { companyId: actor.companyId, leadId: { in: wonIds }, fulfillmentState: { not: 'cancelled' }, agreedAmountMinor: { not: null } }, select: { agreedAmountMinor: true, currency: true, ownerId: true, leadId: true } })
        : Promise.resolve([]),
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
    const salesByCurrency = sumByCurrency(wonOrders.filter((o) => o.currency).map((o) => ({ amountMinor: o.agreedAmountMinor!, currency: o.currency! })));
    const payments = paymentRows.map((r) => ({ kind: r.kind, amountMinor: BigInt(r.total), currency: r.currency }));
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
    const managers: Record<string, { newLeads: number; won: number; inProgress: number; sales: Record<string, bigint> }> = {};
    const m = (id: string | null) => (managers[id ?? 'unassigned'] ??= { newLeads: 0, won: 0, inProgress: 0, sales: {} });
    for (const l of cohort) m(l.ownerId).newLeads++;
    for (const l of leads.filter((x) => inRange(x.firstWonAt))) {
      const owner = ownerAt(l.id, l.firstWonAt!) ?? l.ownerId;
      const row = m(owner);
      row.won++;
      for (const o of wonOrders.filter((o) => o.leadId === l.id && o.currency)) row.sales[o.currency!] = (row.sales[o.currency!] ?? 0n) + o.agreedAmountMinor!;
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
        name: users.find((u) => u.id === id)?.fullName ?? 'Taqsimlanmagan',
        newLeads: v.newLeads,
        won: v.won,
        inProgress: v.inProgress,
        conversion: percent(v.won, v.newLeads),
        salesByCurrency: moneyMap(v.sales),
      })),
      notes: {
        managerAttribution: 'Joriy yuklama — hozirgi mas’ul; tarixiy sotuv — yopilish paytidagi mas’ul.',
        sourceMode: 'Manba — lidning birinchi qayd etilgan manbasi.',
        currency: 'Valyutalar alohida; kurs manbasisiz umumiy summa hisoblanmaydi. Sotuv summasi foyda emas.',
      },
      dataQuality: { dataCollectionStartedAt: company.dataCollectionStartedAt.toISOString(), lastSyncAt: lastSync?.toISOString() ?? null, stale },
    };
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
    const header = ['id', 'name', 'stage', 'owner', 'first_source', 'service_type', 'created_at', 'closed_at', 'amo_lead_id'];
    const lines = rows.map((r) => [r.id, r.name, r.stage, r.ownerId ? users.get(r.ownerId) : '', r.firstSource, r.serviceType, r.createdAt.toISOString(), r.closedAt?.toISOString(), r.amoLeadId].map(esc).join(','));
    await audit(this.d.prisma, actor, { entityType: 'export', entityId: actor.companyId, action: 'leads_csv', newValue: { filters: f, rows: rows.length } });
    return [header.join(','), ...lines].join('\n');
  }
}
