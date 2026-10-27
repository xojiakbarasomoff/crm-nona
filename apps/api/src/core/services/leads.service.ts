import { randomUUID } from 'node:crypto';
import type { Channel, Lead, Prisma, Stage, Tx } from '@crm/database';
import {
  addWorkingMinutes,
  can,
  channelsOfSourceGroup,
  checkTransition,
  isClosed,
  stageOfStatus,
  stagesOfStatus,
  statusOfStage,
  type LeadSourceGroup,
  type LeadStatus,
  type LeadType,
  resumeFromFollowUp,
  stateHash,
  STAGE_LABELS_RU,
  type LeadFacts,
  type WeeklySchedule,
} from '@crm/domain';
import { audit } from '../audit';
import type { Actor, CoreDeps, UserActor } from '../context';
import { headRecipients, notify, publishEvent } from '../events';
import { conflict, forbidden, unprocessable } from '../errors';
import { assertFound, canEditRecord, leadWhere, requireCap } from '../scope';
import { assignNewLead } from './assignment.service';
import { assertSelectableSupplier, serializeSupplier } from './suppliers.service';

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

const req = (l: Pick<Lead, 'requirements'>) => (l.requirements ?? {}) as LeadRequirements;

export async function buildLeadFacts(tx: Tx, lead: Lead): Promise<LeadFacts> {
  const r = req(lead);
  const [sentOffer, acceptedOffer, order] = await Promise.all([
    tx.offer.findFirst({ where: { companyId: lead.companyId, leadId: lead.id, sentAt: { not: null } }, orderBy: { version: 'desc' } }),
    tx.offer.findFirst({ where: { companyId: lead.companyId, leadId: lead.id, acceptedAt: { not: null } }, orderBy: { version: 'desc' } }),
    tx.order.findFirst({ where: { companyId: lead.companyId, leadId: lead.id, fulfillmentState: { not: 'cancelled' } } }),
  ]);
  // Kelishilgan summa: paket narxi yoki paketdan tashqari narxli xizmat (jami qiymat xizmatlar yig'indisidan ham hisoblanadi).
  const pricedServices = order ? await tx.orderService.count({ where: { companyId: lead.companyId, orderId: order.id, removedAt: null, includedInPackage: false, amountMinor: { not: null } } }) : 0;
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
    order: { exists: !!order, agreedAmountSet: (order?.agreedAmountMinor !== null && order?.agreedAmountMinor !== undefined) || pricedServices > 0, saleEvidence: !!order?.saleEvidence },
    lostReasonCode: lead.lostReasonCode,
    followUp: { nextContactAt: lead.nextContactAt?.toISOString() ?? null, note: lead.followUpNote },
  };
}

export function leadStateHash(l: { stage: Stage; ownerId: string | null; deletedAt?: Date | null }) {
  return stateHash({ stage: l.stage, ownerId: l.ownerId, deleted: !!l.deletedAt });
}

export class LeadsService {
  constructor(private readonly d: CoreDeps) {}

  /**
   * Creates a NEW lead with an SLA deadline. Assignment runs at the
   * very end (immediately, or deferred by the caller to just before commit) so that the manager
   * pool row lock is held for as few statements as possible (AC10 under load).
   */
  async createLead(
    tx: Tx,
    p: { companyId: string; contactId: string; name: string; channel: Channel; placement: string; inquiryId: string | null; serviceType: string | null; at: Date; actor: Actor; deferAssignment?: boolean; note?: string | null },
  ): Promise<Lead> {
    const company = await tx.company.findUniqueOrThrow({ where: { id: p.companyId } });
    const firstResponseDueAt = addWorkingMinutes(company.workSchedule as unknown as WeeklySchedule, p.at, company.slaFirstResponseMinutes);
    // Тот же клиент уже обращался раньше → «Повторный» (менеджер может поменять тип вручную).
    const priorLeads = await tx.lead.count({ where: { companyId: p.companyId, contactId: p.contactId, deletedAt: null } });
    const lead = await tx.lead.create({
      data: {
        companyId: p.companyId,
        contactId: p.contactId,
        name: p.name,
        stage: 'NEW',
        ownerId: null,
        serviceType: p.serviceType,
        firstSource: p.channel,
        firstPlacement: p.placement,
        firstInquiryId: p.inquiryId,
        firstResponseDueAt,
        syncState: 'local_only',
        note: p.note ?? null,
        leadType: priorLeads > 0 ? 'REPEAT' : 'NEW',
      },
    });
    if (p.deferAssignment) return lead;
    return this.assignLead(tx, lead, p);
  }

  /**
   * Round-robin assignment (TZ §10). Takes the pool row lock (SELECT … FOR UPDATE) and must be the
   * last step of the caller's transaction: everything after it only touches this lead.
   */
  async assignLead(tx: Tx, lead: Lead, p: { companyId: string; contactId: string; name: string; serviceType: string | null; at: Date; actor: Actor }): Promise<Lead> {
    const decision = await assignNewLead(tx, { companyId: p.companyId, contactId: p.contactId, serviceType: p.serviceType, at: p.at });
    const updated = await tx.lead.update({
      where: { id: lead.id },
      data: { ownerId: decision.userId, assignmentReason: decision.reason, stateHash: leadStateHash({ stage: lead.stage, ownerId: decision.userId }) },
    });
    if (decision.userId) await tx.contact.updateMany({ where: { id: p.contactId, ownerId: null }, data: { ownerId: decision.userId } });
    await tx.leadEvent.create({
      data: { companyId: p.companyId, leadId: lead.id, kind: 'created', newStage: 'NEW', newOwnerId: decision.userId, reason: decision.reason, origin: 'local', algorithmVersion: decision.algorithm, effectiveAt: p.at },
    });
    await audit(tx, p.actor, { entityType: 'lead', entityId: lead.id, action: 'assigned', newValue: { ownerId: decision.userId, reason: decision.reason, algorithm: decision.algorithm, poolId: decision.poolId } });
    if (decision.userId) {
      await notify(tx, { companyId: p.companyId, userId: decision.userId, kind: 'lead_assigned', dedupeKey: `lead_assigned:${lead.id}:${decision.userId}`, title: `Новый лид: ${p.name}`, link: `/leads/${lead.id}` });
    }
    if (decision.alertHead) {
      for (const uid of await headRecipients(tx, p.companyId)) {
        await notify(tx, {
          companyId: p.companyId,
          userId: uid,
          kind: decision.reason === 'duty_fallback' ? 'lead_duty_fallback' : 'lead_awaiting_assignment',
          dedupeKey: `lead_unassigned:${lead.id}:${uid}`,
          title: decision.reason === 'duty_fallback' ? `Лид передан дежурному: ${p.name}` : `Ожидает распределения: ${p.name}`,
          link: `/leads/${lead.id}`,
        });
      }
    }
    // Задача «первый контакт» создаётся сразу при назначении (идемпотентно по ключу).
    await this.createCrmTask(tx, {
      companyId: p.companyId,
      key: `${lead.id}:first_contact:created`,
      entityId: lead.id,
      kind: 'first_contact',
      text: `Первый контакт: ${p.name}`,
      responsibleUserId: updated.ownerId,
      dueAt: updated.firstResponseDueAt ?? new Date(p.at.getTime() + 15 * 60_000),
    });
    return updated;
  }

  async findActiveLeads(tx: Tx, companyId: string, contactId: string) {
    return tx.lead.findMany({ where: { companyId, contactId, deletedAt: null, stage: { notIn: ['WON', 'LOST'] } }, orderBy: { updatedAt: 'desc' } });
  }

  // ---------------- Web actions ----------------

  async list(actor: UserActor, q: { stage?: Stage; status?: LeadStatus; sourceGroup?: LeadSourceGroup; leadType?: LeadType; ownerId?: string; source?: Channel; search?: string; fromAd?: 'true'; cursor?: string; limit: number }) {
    const search = q.search?.trim() ?? '';
    // Qidiruv: lid nomi, mijoz ismi/familiyasi, telefon, Instagram va Telegram username (@ bilan yoki usiz). Foydalanuvchi ko'ra oladigan
    // BARCHA lidlar bo'yicha (leadWhere ko'rinish doirasini beradi) — faqat yuklangan sahifa emas.
    const searchOr: Prisma.LeadWhereInput[] = [];
    if (search) {
      const tokens = search.split(/\s+/).filter(Boolean);
      const ci = { mode: 'insensitive' as const };
      const tokenMatch = (t: string): Prisma.ContactWhereInput => {
        const h = t.replace(/^@+/, '');
        return { OR: [{ fullName: { contains: t, ...ci } }, { firstName: { contains: t, ...ci } }, { lastName: { contains: t, ...ci } }, ...(h ? [{ instagramUsername: { contains: h, ...ci } }, { telegramUsername: { contains: h, ...ci } }] : [])] };
      };
      const digits = search.replace(/\D/g, '');
      const contacts = await this.d.prisma.contact.findMany({
        where: { companyId: actor.companyId, deletedAt: null, OR: [{ AND: tokens.map(tokenMatch) }, ...(digits.length >= 3 && /^[+\d\s().-]+$/.test(search) ? [{ primaryPhone: { contains: digits } }] : [])] },
        select: { id: true },
        take: 2000,
      });
      searchOr.push({ name: { contains: search, mode: 'insensitive' } }, { name: { contains: search.replace(/^@+/, ''), mode: 'insensitive' } });
      if (contacts.length) searchOr.push({ contactId: { in: contacts.map((c) => c.id) } });
    }
    const where: Prisma.LeadWhereInput = leadWhere(actor, {
      ...(q.stage ? { stage: q.stage } : q.status ? { stage: { in: stagesOfStatus(q.status) } } : {}),
      ...(q.source ? { firstSource: q.source } : q.sourceGroup ? { firstSource: { in: channelsOfSourceGroup(q.sourceGroup) } } : {}),
      ...(q.leadType ? { leadType: q.leadType } : {}),
      ...(q.ownerId && actor.role !== 'MANAGER' ? { ownerId: q.ownerId } : {}),
      // «Только из рекламы»: Direct'da Meta reklama dalili bor lidlar yoki lid-forma (Lead Ads) lidlari; dalilsiz lidlar kirmaydi.
      AND: [...(searchOr.length ? [{ OR: searchOr }] : []), ...(q.fromAd ? [{ OR: [{ adReferralAt: { not: null } }, { firstSource: { in: channelsOfSourceGroup('ADS') } }] }] : [])],
    });
    // List view: only the columns the table needs (less mapping work per row).
    const rows = await this.d.prisma.lead.findMany({
      where,
      select: { id: true, name: true, stage: true, leadType: true, firstSource: true, createdAt: true, ownerId: true, anomaly: true, slaBreachedAt: true, firstHumanActionAt: true, contactId: true, version: true, adReferralAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, q.limit);
    // Instagram username kontaktda alohida; ro'yxat/karta uchun bitta so'rov bilan qo'shiladi.
    const contacts = await this.d.prisma.contact.findMany({ where: { companyId: actor.companyId, id: { in: [...new Set(page.map((r) => r.contactId))] } }, select: { id: true, instagramUsername: true } });
    const uname = new Map(contacts.map((c) => [c.id, c.instagramUsername]));
    const items = page.map(({ adReferralAt, ...r }) => ({ ...r, status: statusOfStage(r.stage), fromAd: !!adReferralAt, contactInstagramUsername: uname.get(r.contactId) ?? null }));
    return { items, nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null };
  }

  async get(actor: UserActor, id: string) {
    const lead = assertFound(await this.d.prisma.lead.findFirst({ where: leadWhere(actor, { id }) }), 'Лид');
    const [events, offers, orders, contact, inquiries] = await Promise.all([
      this.d.prisma.leadEvent.findMany({ where: { companyId: actor.companyId, leadId: id }, orderBy: { effectiveAt: 'asc' } }),
      this.d.prisma.offer.findMany({ where: { companyId: actor.companyId, leadId: id }, orderBy: { version: 'desc' } }),
      this.d.prisma.order.findMany({ where: { companyId: actor.companyId, leadId: id }, select: { id: true, orderNo: true, fulfillmentState: true, tourOperatorId: true } }),
      this.d.prisma.contact.findFirst({ where: { companyId: actor.companyId, id: lead.contactId }, select: { id: true, fullName: true, firstName: true, lastName: true, primaryPhone: true, telegramUsername: true, instagramUsername: true, instagramName: true } }),
      this.d.prisma.inquiry.findMany({ where: { companyId: actor.companyId, leadId: id, channel: { in: ['instagram_lead_ads', 'meta_lead_ads'] } }, orderBy: { receivedAt: 'desc' }, take: 100, select: { id: true, channel: true, receivedAt: true, formData: true, attribution: true } }),
    ]);
    // Faol buyurtma bo'lsa, turoperator — buyurtmaniki (tarixiy bog'lanish); aks holda lidniki.
    const activeOrder = orders.find((o) => o.fulfillmentState !== 'cancelled') ?? null;
    const operatorId = activeOrder ? activeOrder.tourOperatorId : lead.tourOperatorId;
    const op = operatorId ? await this.d.prisma.supplier.findFirst({ where: { id: operatorId, companyId: actor.companyId } }) : null;
    const { SaleService } = await import('./sale.service');
    const [sale, conversations] = await Promise.all([new SaleService(this.d).view(actor, lead), this.conversationsFor(actor, lead)]);
    return {
      lead,
      status: statusOfStage(lead.stage),
      events,
      offers,
      orders,
      contact,
      inquiries,
      sale,
      conversations,
      tourOperator: op ? serializeSupplier(op, can(actor.role, 'reference.view_full')) : null,
      operatorOwnedByOrder: activeOrder ? { id: activeOrder.id, orderNo: activeOrder.orderNo } : null,
    };
  }

  /** Переписка Instagram только этого клиента (по контакту лида), последние 200 сообщений каждой беседы. */
  private async conversationsFor(actor: UserActor, lead: Lead) {
    const convs = await this.d.prisma.conversation.findMany({ where: { companyId: actor.companyId, contactId: lead.contactId }, orderBy: { createdAt: 'asc' } });
    return Promise.all(
      convs.map(async (c) => {
        const rows = await this.d.prisma.message.findMany({
          where: { companyId: actor.companyId, conversationId: c.id, isInternalNote: false },
          orderBy: { createdAt: 'desc' },
          take: 200,
          select: { id: true, direction: true, type: true, content: true, attachments: true, state: true, error: true, actorUserId: true, isEcho: true, providerAt: true, createdAt: true, contentPurgedAt: true },
        });
        const { replyDecision } = await import('./direct-reply.service');
        const reply = await replyDecision(this.d, actor, lead, c);
        return { id: c.id, peerUsername: c.peerUsername, lastInboundAt: c.lastInboundAt, lastHumanReplyAt: c.lastHumanReplyAt, messages: rows.reverse(), reply };
      }),
    );
  }

  /**
   * Упрощённая смена статуса (Новый / В работе / Продано / Отменён / Нет ответа). Хранится в прежнем поле stage,
   * поэтому история и продажи не теряются. Повторное сохранение того же статуса ничего не меняет.
   */
  async changeStatus(actor: UserActor, id: string, version: number, status: LeadStatus) {
    requireCap(actor, 'leads.work');
    const result = await this.d.prisma.$transaction(async (tx) => {
      const lead = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id }) }), 'Лид');
      if (!canEditRecord(actor, lead.ownerId)) throw forbidden();
      if (lead.version !== version) throw conflict('VERSION_CONFLICT', 'Лид был изменён другим пользователем. Обновите страницу.');
      if (statusOfStage(lead.stage) === status) return { lead, ownerId: lead.ownerId };
      const target = stageOfStatus(status);
      const now = this.d.clock.now();
      await this.moveStage(tx, actor, lead, target, now, { reason: null, returnStage: null, firstAction: !lead.firstHumanActionAt });
      return { lead: await tx.lead.findUniqueOrThrow({ where: { id } }), ownerId: lead.ownerId };
    });
    await publishEvent(this.d.redis, { companyId: actor.companyId, entityType: 'lead', entityId: id, ownerId: result.ownerId, kind: 'updated' });
    return result.lead;
  }

  /** Тип лида и примечание. Пользователь может менять это только в своих лидах. */
  async updateBasics(actor: UserActor, id: string, patch: { leadType?: LeadType; note?: string | null }) {
    return this.d.prisma.$transaction(async (tx) => {
      const lead = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id }) }), 'Лид');
      if (!canEditRecord(actor, lead.ownerId)) throw forbidden();
      const data: Prisma.LeadUpdateInput = {};
      if (patch.leadType !== undefined && patch.leadType !== lead.leadType) data.leadType = patch.leadType;
      if (patch.note !== undefined && (patch.note?.trim() || null) !== lead.note) data.note = patch.note?.trim() || null;
      if (!Object.keys(data).length) return lead;
      data.version = { increment: 1 };
      const updated = await tx.lead.update({ where: { id }, data });
      await audit(tx, actor, { entityType: 'lead', entityId: id, action: 'basics_updated', oldValue: { leadType: lead.leadType, note: lead.note }, newValue: { leadType: updated.leadType, note: updated.note } });
      return updated;
    });
  }

  /** Local tourism fields are owned by PostgreSQL and change immediately (optimistic lock). */
  async updateDetails(
    actor: UserActor,
    id: string,
    version: number,
    patch: { requirements?: LeadRequirements; serviceType?: string | null; contactOutcome?: string | null; offerPrepDueAt?: Date | null; lostReasonCode?: string | null; lostNote?: string | null; nextContactAt?: Date | null; followUpNote?: string | null; tourOperatorId?: string | null },
  ) {
    return this.d.prisma.$transaction(async (tx) => {
      const lead = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id }) }), 'Лид');
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
      if (patch.tourOperatorId !== undefined && patch.tourOperatorId !== lead.tourOperatorId) {
        // Faol buyurtma bor bo'lsa, turoperator buyurtmaning tarixiy bog'lanishi: uni buyurtma kartasida (sabab va audit bilan) o'zgartiring.
        const active = await tx.order.findFirst({ where: { companyId: actor.companyId, leadId: id, fulfillmentState: { not: 'cancelled' } }, select: { id: true, orderNo: true } });
        if (active) throw unprocessable('ORDER_OWNS_OPERATOR', `Есть заказ ${active.orderNo}: туроператора меняйте в карточке заказа (с записью в журнале). Статистика прошлых продаж не изменится.`, { tourOperatorId: 'order_exists' }, { orderId: active.id });
      }
      if (patch.tourOperatorId !== undefined) {
        // Turoperator — yetkazib beruvchi; reklama manbasi (firstSource) bilan aralashmaydi.
        if (patch.tourOperatorId) await assertSelectableSupplier(tx, actor.companyId, patch.tourOperatorId, { kind: 'tour_operator', unchanged: patch.tourOperatorId === lead.tourOperatorId });
        (data as Prisma.LeadUncheckedUpdateInput).tourOperatorId = patch.tourOperatorId;
      }
      if (patch.contactOutcome && !lead.firstHumanActionAt) data.firstHumanActionAt = this.d.clock.now();
      const res = await tx.lead.updateMany({ where: { id, version }, data: data as Prisma.LeadUpdateManyMutationInput });
      if (res.count !== 1) throw conflict('VERSION_CONFLICT', 'Лид был изменён другим пользователем. Обновите страницу.');
      await audit(tx, actor, { entityType: 'lead', entityId: id, action: 'details_updated', oldValue: pick(lead, Object.keys(patch)), newValue: patch });
      return tx.lead.findUniqueOrThrow({ where: { id } });
    });
  }

  /** Смена этапа применяется сразу: правила переходов проверяются, событие и аудит пишутся в той же транзакции. */
  async requestStageChange(actor: UserActor, id: string, version: number, target: Stage, extra: { reason?: string | null } = {}) {
    const result = await this.d.prisma.$transaction(async (tx) => {
      const lead = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id }) }), 'Лид');
      if (!canEditRecord(actor, lead.ownerId)) throw forbidden();
      if (lead.version !== version) throw conflict('VERSION_CONFLICT', 'Лид был изменён другим пользователем. Обновите страницу.');
      const facts = await buildLeadFacts(tx, lead);
      const check = checkTransition(lead.stage, target, facts, lead.returnStage);
      if (!check.ok) {
        if (check.code === 'MISSING_FIELDS') {
          throw unprocessable('MISSING_FIELDS', `Для перехода на этап «${STAGE_LABELS_RU[target]}» не заполнены обязательные поля`, Object.fromEntries((check.missing ?? []).map((m) => [m, 'required'])));
        }
        if (check.code === 'CLOSED_REQUIRES_REOPEN') throw unprocessable('CLOSED_REQUIRES_REOPEN', 'Закрытый лид может заново открыть только администратор, указав причину');
        throw unprocessable(check.code, 'Переход на этот этап невозможен');
      }
      const now = this.d.clock.now();
      await this.moveStage(tx, actor, lead, target, now, {
        reason: extra.reason ?? null,
        returnStage: check.returnStage ?? (lead.stage === 'FOLLOW_UP' ? null : lead.returnStage),
        firstAction: !lead.firstHumanActionAt,
      });
      return { lead: await tx.lead.findUniqueOrThrow({ where: { id } }), ownerId: lead.ownerId };
    });
    await publishEvent(this.d.redis, { companyId: actor.companyId, entityType: 'lead', entityId: id, ownerId: result.ownerId, kind: 'updated' });
    return result.lead;
  }

  /** Общая часть смены этапа: сам лид, событие, аудит и побочные эффекты (отмена задач, заказ, повторный контакт). */
  private async moveStage(
    tx: Tx,
    actor: Actor,
    lead: Lead,
    target: Stage,
    now: Date,
    o: { reason: string | null; returnStage: Stage | null; firstAction: boolean; reopen?: boolean },
  ) {
    const data: Prisma.LeadUncheckedUpdateInput = {
      stage: target,
      returnStage: o.returnStage,
      stateHash: leadStateHash({ stage: target, ownerId: lead.ownerId }),
      version: { increment: 1 },
      ...(o.firstAction ? { firstHumanActionAt: now } : {}),
    };
    if (isClosed(target)) data.closedAt = now;
    if (target === 'WON' && !lead.firstWonAt) data.firstWonAt = now;
    if (!isClosed(target) && isClosed(lead.stage)) data.closedAt = null;
    await tx.lead.update({ where: { id: lead.id }, data });
    await tx.leadEvent.create({
      data: {
        companyId: lead.companyId,
        leadId: lead.id,
        kind: o.reopen || (isClosed(lead.stage) && !isClosed(target)) ? 'reopened' : 'stage_change',
        oldStage: lead.stage,
        newStage: target,
        reason: o.reason,
        origin: 'local',
        actorId: actor.type === 'user' ? actor.id : null,
        effectiveAt: now,
        observedAt: now,
      },
    });
    await audit(tx, actor, { entityType: 'lead', entityId: lead.id, action: o.reopen ? 'reopened' : 'stage_changed', oldValue: { stage: lead.stage }, newValue: { stage: target, reason: o.reason } });
    if (target === 'LOST') await this.cancelOpenSalesTasks(tx, lead.companyId, lead.id);
    if (target === 'WON') await this.ensureOrderForWon(tx, lead.companyId, lead, now, actor);
    if (lead.stage === 'WON' && target !== 'WON') await this.cancelOrderForUnsold(tx, actor, lead, now);
    if (target === 'FOLLOW_UP') {
      await this.createCrmTask(tx, {
        companyId: lead.companyId,
        key: `${lead.id}:follow_up:${lead.version}`,
        entityId: lead.id,
        kind: 'follow_up',
        text: `Повторный контакт: ${lead.followUpNote ?? ''}`.trim(),
        responsibleUserId: lead.ownerId,
        dueAt: lead.nextContactAt ?? new Date(now.getTime() + 24 * 3600_000),
      });
    }
  }

  async requestReassign(actor: UserActor, id: string, toUserId: string, reason: string) {
    requireCap(actor, 'leads.reassign');
    const lead = await this.d.prisma.$transaction(async (tx) => {
      const current = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id }) }), 'Лид');
      const target = await tx.user.findFirst({ where: { id: toUserId, companyId: actor.companyId, status: 'active' } });
      if (!target) throw unprocessable('ASSIGNEE_INVALID', 'Выбранный сотрудник неактивен', { toUserId: 'invalid' });
      if (current.ownerId === toUserId) return current;
      await reassignLeadLocal(tx, actor, current, toUserId, reason, this.d.clock.now());
      return tx.lead.findUniqueOrThrow({ where: { id } });
    });
    await publishEvent(this.d.redis, { companyId: actor.companyId, entityType: 'lead', entityId: id, ownerId: lead.ownerId, kind: 'updated' });
    return lead;
  }

  async requestReopen(actor: UserActor, id: string, reason: string, toStage: Stage = 'CONTACTED') {
    requireCap(actor, 'leads.reopen');
    if (!reason?.trim()) throw unprocessable('REASON_REQUIRED', 'Укажите причину повторного открытия', { reason: 'required' });
    const lead = await this.d.prisma.$transaction(async (tx) => {
      const current = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id }) }), 'Лид');
      if (!isClosed(current.stage)) throw unprocessable('NOT_CLOSED', 'Лид не закрыт');
      if (isClosed(toStage)) throw unprocessable('INVALID_TARGET', 'При повторном открытии выберите открытый этап');
      await this.moveStage(tx, actor, current, toStage, this.d.clock.now(), { reason, returnStage: current.returnStage, firstAction: false, reopen: true });
      return tx.lead.findUniqueOrThrow({ where: { id } });
    });
    await publishEvent(this.d.redis, { companyId: actor.companyId, entityType: 'lead', entityId: id, ownerId: lead.ownerId, kind: 'updated' });
    return lead;
  }

  /** Owner change cascades to local order, segments, active reminders and open CRM tasks. */
  async cascadeOwner(tx: Tx, companyId: string, leadId: string, fromUserId: string | null, toUserId: string) {
    return cascadeLeadOwner(tx, companyId, leadId, fromUserId, toUserId);
  }

  async cancelOpenSalesTasks(tx: Tx, companyId: string, leadId: string) {
    await tx.crmTask.updateMany({ where: { companyId, entityId: leadId, state: { in: ['pending', 'open'] }, kind: { in: ['first_contact', 'follow_up', 'offer_prep'] } }, data: { state: 'cancelled' } });
  }

  /**
   * WON without a local order → idempotent draft order (TZ §12.3, AC15). If the lead was «Продано» before and
   * the sale was cancelled by a status change, the same order is reactivated — no duplicate sale.
   */
  async ensureOrderForWon(tx: Tx, companyId: string, lead: Lead, now: Date, actor?: Actor) {
    const existing = await tx.order.findFirst({ where: { companyId, leadId: lead.id, fulfillmentState: { not: 'cancelled' } } });
    if (existing) return existing;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order:${lead.id}`}, 0))`;
    const again = await tx.order.findFirst({ where: { companyId, leadId: lead.id, fulfillmentState: { not: 'cancelled' } } });
    if (again) return again;
    const previous = await tx.order.findFirst({ where: { companyId, leadId: lead.id, fulfillmentState: 'cancelled' }, orderBy: { cancelledAt: { sort: 'desc', nulls: 'last' } } });
    if (previous) {
      const revived = await tx.order.update({ where: { id: previous.id }, data: { fulfillmentState: previous.confirmedAt ? 'confirmed' : 'draft', cancelledAt: null, version: { increment: 1 } } });
      if (actor) await audit(tx, actor, { entityType: 'order', entityId: previous.id, action: 'reactivated', oldValue: { fulfillmentState: 'cancelled' }, newValue: { fulfillmentState: revived.fulfillmentState, reason: 'lead_sold_again' } });
      return revived;
    }
    const { createOrderRow } = await import('./orders.service');
    return createOrderRow(tx, { companyId, leadId: lead.id, contactId: lead.contactId, ownerId: lead.ownerId, now, fulfillmentState: 'draft', tourOperatorId: lead.tourOperatorId });
  }

  /** Статус ушёл с «Продано»: продажа (заказ) отменяется вместе с напоминаниями; цены и история сохраняются. */
  private async cancelOrderForUnsold(tx: Tx, actor: Actor, lead: Lead, now: Date) {
    const order = await tx.order.findFirst({ where: { companyId: lead.companyId, leadId: lead.id, fulfillmentState: { not: 'cancelled' } } });
    if (!order) return;
    await tx.order.update({ where: { id: order.id }, data: { fulfillmentState: 'cancelled', cancelledAt: now, version: { increment: 1 } } });
    const occ = await tx.reminderOccurrence.findMany({ where: { companyId: lead.companyId, orderId: order.id, state: { in: ['scheduled', 'dispatching', 'due', 'snoozed'] } }, select: { id: true } });
    if (occ.length) {
      const ids = occ.map((o) => o.id);
      await tx.reminderOccurrence.updateMany({ where: { id: { in: ids } }, data: { state: 'cancelled', cancelledAt: now, cancelReason: 'lead_not_sold', leaseUntil: null } });
      await tx.crmTask.updateMany({ where: { companyId: lead.companyId, entityType: 'occurrence', entityId: { in: ids }, state: { in: ['pending', 'open'] } }, data: { state: 'cancelled' } });
    }
    await audit(tx, actor, { entityType: 'order', entityId: order.id, action: 'cancelled_by_status', oldValue: { fulfillmentState: order.fulfillmentState }, newValue: { fulfillmentState: 'cancelled', remindersCancelled: occ.length } });
  }

  async createCrmTask(tx: Tx, t: { companyId: string; key: string; entityId: string; kind: string; text: string; responsibleUserId: string | null; dueAt: Date; entityType?: string }) {
    const res = await tx.crmTask.createMany({
      data: [{ companyId: t.companyId, automationKey: t.key, entityType: t.entityType ?? 'lead', entityId: t.entityId, kind: t.kind, text: t.text, responsibleUserId: t.responsibleUserId, dueAt: t.dueAt, state: 'pending' }],
      skipDuplicates: true,
    });
    if (res.count === 0) return null;
    return tx.crmTask.findUniqueOrThrow({ where: { companyId_automationKey: { companyId: t.companyId, automationKey: t.key } } });
  }

  newCorrelationId() {
    return randomUUID();
  }
}

/** Владелец лида меняется сразу: событие, аудит, каскад на заказы/сегменты/напоминания/задачи и уведомление нового ответственного. */
export async function reassignLeadLocal(tx: Tx, actor: Actor, lead: Lead, toUserId: string, reason: string, now: Date) {
  await tx.lead.update({ where: { id: lead.id }, data: { ownerId: toUserId, assignmentReason: 'manual', stateHash: leadStateHash({ stage: lead.stage, ownerId: toUserId }), version: { increment: 1 } } });
  await tx.leadEvent.create({
    data: { companyId: lead.companyId, leadId: lead.id, kind: 'owner_change', oldOwnerId: lead.ownerId, newOwnerId: toUserId, reason, origin: 'local', actorId: actor.type === 'user' ? actor.id : null, effectiveAt: now, observedAt: now },
  });
  await cascadeLeadOwner(tx, lead.companyId, lead.id, lead.ownerId, toUserId);
  await audit(tx, actor, { entityType: 'lead', entityId: lead.id, action: 'owner_changed', oldValue: { ownerId: lead.ownerId }, newValue: { ownerId: toUserId, reason } });
  await notify(tx, { companyId: lead.companyId, userId: toUserId, kind: 'lead_assigned', dedupeKey: `lead_assigned:${lead.id}:${toUserId}:${lead.version}`, title: `Вам назначен лид: ${lead.name}`, link: `/leads/${lead.id}` });
}

export async function cascadeLeadOwner(tx: Tx, companyId: string, leadId: string, fromUserId: string | null, toUserId: string) {
  const orders = await tx.order.findMany({ where: { companyId, leadId, fulfillmentState: { notIn: ['completed', 'cancelled'] } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  await tx.order.updateMany({ where: { id: { in: orderIds } }, data: { ownerId: toUserId } });
  await tx.flightSegment.updateMany({ where: { companyId, orderId: { in: orderIds }, active: true }, data: { ownerId: toUserId } });
  await tx.reminderOccurrence.updateMany({
    where: { companyId, orderId: { in: orderIds }, state: { in: ['scheduled', 'dispatching', 'due', 'snoozed'] }, ...(fromUserId ? { assigneeId: fromUserId } : {}) },
    data: { assigneeId: toUserId },
  });
  await tx.crmTask.updateMany({ where: { companyId, entityId: leadId, state: { in: ['pending', 'open'] } }, data: { responsibleUserId: toUserId } });
}

function pick(obj: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

export { resumeFromFollowUp };
