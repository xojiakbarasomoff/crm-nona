import type { Channel, Prisma, Stage } from '@crm/database';
import {
  bucketKey,
  can,
  closedConversion,
  cohortConversion,
  companyDateRangeToUtc,
  firstResponseStats,
  formatMoney,
  percent,
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

  async compute(actor: UserActor, f: DashboardFilters) {
    const company = await this.d.prisma.company.findUniqueOrThrow({ where: { id: actor.companyId } });
    const { start, end } = companyDateRangeToUtc(f.from, f.to, company.timezone);
    const scope = this.leadScope(actor, f);
    if (f.departureFrom && f.departureTo) {
      const dr = companyDateRangeToUtc(f.departureFrom, f.departureTo, company.timezone);
      const orders = await this.d.prisma.flightSegment.findMany({ where: { companyId: actor.companyId, active: true, departureAtUtc: { gte: dr.start, lt: dr.end } }, select: { order: { select: { leadId: true } } } });
      scope.id = { in: [...new Set(orders.map((o) => o.order.leadId))] };
    }

    // Leads relevant for the period: created in period, or closed in period.
    const leads = await this.d.prisma.lead.findMany({
      where: { ...scope, OR: [{ createdAt: { gte: start, lt: end } }, { closedAt: { gte: start, lt: end } }, { firstWonAt: { gte: start, lt: end } }] },
      select: { id: true, createdAt: true, stage: true, firstWonAt: true, firstSource: true, firstHumanActionAt: true, ownerId: true },
    });
    const leadIds = leads.map((l) => l.id);
    const closeEvents = leadIds.length
      ? await this.d.prisma.leadEvent.findMany({ where: { companyId: actor.companyId, leadId: { in: leadIds }, newStage: { in: ['WON', 'LOST'] } }, select: { leadId: true, newStage: true, effectiveAt: true } })
      : [];
    const ownerEvents = leadIds.length
      ? await this.d.prisma.leadEvent.findMany({ where: { companyId: actor.companyId, leadId: { in: leadIds }, newOwnerId: { not: null } }, select: { leadId: true, newOwnerId: true, effectiveAt: true }, orderBy: { effectiveAt: 'asc' } })
      : [];
    const humanEvents = leadIds.length
      ? await this.d.prisma.leadEvent.findMany({ where: { companyId: actor.companyId, leadId: { in: leadIds }, actorId: { not: null } }, select: { leadId: true }, distinct: ['leadId'] })
      : [];
    const humanSet = new Set(humanEvents.map((e) => e.leadId));

    const facts: LeadFact[] = leads.map((l) => ({
      id: l.id,
      createdAt: l.createdAt,
      stage: l.stage,
      firstWonAt: l.firstWonAt,
      closes: closeEvents.filter((e) => e.leadId === l.id).map((e) => ({ stage: e.newStage as 'WON' | 'LOST', at: e.effectiveAt })),
    }));
    const inRange = (d: Date | null) => !!d && d >= start && d < end;
    const cohort = leads.filter((l) => inRange(l.createdAt));

    const bySource: Record<string, number> = {};
    for (const l of cohort) bySource[l.firstSource] = (bySource[l.firstSource] ?? 0) + 1;
    const adsLeads = (bySource.instagram_lead_ads ?? 0) + (bySource.meta_lead_ads ?? 0);
    const directLeads = bySource.instagram_direct ?? 0;

    const inquiries = await this.d.prisma.inquiry.count({
      where: { companyId: actor.companyId, receivedAt: { gte: start, lt: end }, ...(f.source ? { channel: f.source } : {}), ...(can(actor.role, 'dashboard.company') && !f.ownerId ? {} : { leadId: { in: (await this.d.prisma.lead.findMany({ where: scope, select: { id: true } })).map((x) => x.id) } }) },
    });

    // Snapshots (current state, not period-bound).
    const inProgress = await this.d.prisma.lead.count({ where: { ...scope, stage: { notIn: ['WON', 'LOST'] } } });
    const scopedConversationLeads = await this.d.prisma.lead.findMany({ where: { ...scope, stage: { notIn: ['WON', 'LOST'] } }, select: { id: true } });
    const awaiting = scopedConversationLeads.length
      ? await this.d.prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*)::bigint AS n FROM conversations
          WHERE company_id = ${actor.companyId}::uuid AND lead_id = ANY(${scopedConversationLeads.map((l) => l.id)}::uuid[])
            AND last_inbound_at IS NOT NULL AND (last_human_reply_at IS NULL OR last_human_reply_at < last_inbound_at)`
      : [{ n: 0n }];

    const wonIds = leads.filter((l) => inRange(l.firstWonAt)).map((l) => l.id);
    const lostCount = new Set(closeEvents.filter((e) => e.newStage === 'LOST' && inRange(e.effectiveAt)).filter((e) => leads.find((l) => l.id === e.leadId)?.stage === 'LOST').map((e) => e.leadId)).size;
    const cancelledOrders = await this.d.prisma.order.count({ where: { companyId: actor.companyId, fulfillmentState: 'cancelled', cancelledAt: { gte: start, lt: end }, lead: scope } });

    const wonOrders = wonIds.length ? await this.d.prisma.order.findMany({ where: { companyId: actor.companyId, leadId: { in: wonIds }, fulfillmentState: { not: 'cancelled' }, agreedAmountMinor: { not: null } }, select: { agreedAmountMinor: true, currency: true, ownerId: true, leadId: true } }) : [];
    const salesByCurrency = sumByCurrency(wonOrders.filter((o) => o.currency).map((o) => ({ amountMinor: o.agreedAmountMinor!, currency: o.currency! })));

    const scopedOrderIds = (await this.d.prisma.order.findMany({ where: { companyId: actor.companyId, lead: scope }, select: { id: true } })).map((o) => o.id);
    const payments = scopedOrderIds.length ? await this.d.prisma.payment.findMany({ where: { companyId: actor.companyId, orderId: { in: scopedOrderIds }, status: 'confirmed', receivedAt: { gte: start, lt: end } }, select: { kind: true, amountMinor: true, currency: true } }) : [];

    const convs = await this.d.prisma.conversation.findMany({
      where: { companyId: actor.companyId, firstInboundAt: { gte: start, lt: end }, ...(scope.ownerId || scope.firstSource || scope.serviceType || scope.id ? { leadId: { in: (await this.d.prisma.lead.findMany({ where: scope, select: { id: true } })).map((x) => x.id) } } : {}) },
      select: { firstInboundAt: true, firstHumanReplyAt: true },
    });
    const fr = firstResponseStats(convs.map((c) => ({ firstInboundAt: c.firstInboundAt!, firstHumanReplyAt: c.firstHumanReplyAt })));
    const schedule = company.workSchedule as unknown as WeeklySchedule;
    const slaMinutes = convs.filter((c) => c.firstHumanReplyAt).map((c) => workingMinutesBetween(schedule, c.firstInboundAt!, c.firstHumanReplyAt!));

    // Manager results: current owner for workload, owner at close time for historical sales.
    const ownerAt = (leadId: string, at: Date) => {
      let owner: string | null = null;
      for (const e of ownerEvents) if (e.leadId === leadId && e.effectiveAt <= at) owner = e.newOwnerId;
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
        cancelledOrders,
        cohortConversion: cohortConversion(facts, start, end),
        closedConversion: closedConversion(facts, start, end),
        salesByCurrency: moneyMap(salesByCurrency),
        paymentsByCurrency: moneyMap(sumByCurrency(payments.filter((p) => p.kind === 'payment').map((p) => ({ amountMinor: p.amountMinor, currency: p.currency })))),
        refundsByCurrency: moneyMap(sumByCurrency(payments.filter((p) => p.kind === 'refund').map((p) => ({ amountMinor: p.amountMinor, currency: p.currency })))),
        firstResponse: { ...fr, slaWorkingMinutesMedian: median(slaMinutes) },
      },
      snapshot: { inProgress, awaitingReply: Number(awaiting[0]?.n ?? 0), asOf: this.d.clock.now().toISOString() },
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
