/**
 * Sales pipeline stages and transition rules (TZ §11).
 */

export const STAGES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'PREPARING_OFFER',
  'OFFER_SENT',
  'AWAITING_PAYMENT',
  'WON',
  'LOST',
  'FOLLOW_UP',
  'NO_ANSWER',
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS_RU: Record<Stage, string> = {
  NEW: 'Новый лид',
  CONTACTED: 'Контакт установлен',
  QUALIFIED: 'Потребности выяснены',
  PREPARING_OFFER: 'Готовится предложение',
  OFFER_SENT: 'Предложение отправлено',
  AWAITING_PAYMENT: 'Ожидается оплата',
  WON: 'Продажа завершена',
  LOST: 'Отменён',
  FOLLOW_UP: 'Требуется повторный контакт',
  NO_ANSWER: 'Нет ответа',
};

/**
 * Упрощённый статус лида (интерфейс). Хранится в том же поле `stage`, поэтому история и продажи не теряются:
 * прежние промежуточные этапы показываются как «В работе».
 */
export const LEAD_STATUSES = ['NEW', 'IN_PROGRESS', 'SOLD', 'CANCELLED', 'NO_ANSWER'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const LEAD_STATUS_LABELS_RU: Record<LeadStatus, string> = { NEW: 'Новый', IN_PROGRESS: 'В работе', SOLD: 'Продано', CANCELLED: 'Отменён', NO_ANSWER: 'Нет ответа' };
export function statusOfStage(stage: Stage): LeadStatus {
  if (stage === 'NEW') return 'NEW';
  if (stage === 'WON') return 'SOLD';
  if (stage === 'LOST') return 'CANCELLED';
  if (stage === 'NO_ANSWER') return 'NO_ANSWER';
  return 'IN_PROGRESS';
}
/** Этап, в который записывается выбранный статус. */
export function stageOfStatus(status: LeadStatus): Stage {
  return ({ NEW: 'NEW', IN_PROGRESS: 'CONTACTED', SOLD: 'WON', CANCELLED: 'LOST', NO_ANSWER: 'NO_ANSWER' } as const)[status];
}
/** Все этапы, которые показываются как данный статус (для фильтров). */
export function stagesOfStatus(status: LeadStatus): Stage[] {
  return STAGES.filter((s) => statusOfStage(s) === status);
}

export const LEAD_TYPES = ['NEW', 'REFERRAL', 'REPEAT'] as const;
export type LeadType = (typeof LEAD_TYPES)[number];
export const LEAD_TYPE_LABELS_RU: Record<LeadType, string> = { NEW: 'Новый', REFERRAL: 'По рекомендации', REPEAT: 'Повторный' };

/** «Источник» в интерфейсе: три значения поверх технического канала. */
export type LeadSourceGroup = 'DIRECT' | 'ADS' | 'MANUAL';
export const LEAD_SOURCE_LABELS_RU: Record<LeadSourceGroup, string> = { DIRECT: 'Instagram Direct', ADS: 'Реклама', MANUAL: 'Вручную' };
export function sourceGroupOf(channel: string): LeadSourceGroup {
  if (channel === 'instagram_direct') return 'DIRECT';
  if (channel === 'instagram_lead_ads' || channel === 'meta_lead_ads') return 'ADS';
  return 'MANUAL';
}
export function channelsOfSourceGroup(g: LeadSourceGroup): string[] {
  return g === 'DIRECT' ? ['instagram_direct'] : g === 'ADS' ? ['instagram_lead_ads', 'meta_lead_ads'] : ['manual', 'amocrm', 'other'];
}

export const CLOSED_STAGES: ReadonlySet<Stage> = new Set(['WON', 'LOST']);
export const isClosed = (s: Stage) => CLOSED_STAGES.has(s);
export const isOpen = (s: Stage) => !CLOSED_STAGES.has(s);

export const SERVICE_TYPES = ['avia', 'tour_package', 'hotel', 'transfer', 'visa', 'other'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

/** Facts about a lead that transition rules depend on. */
export interface LeadFacts {
  stage: Stage;
  hasContactOrIdentifier: boolean;
  hasSource: boolean;
  ownerId: string | null;
  contactOutcomeRecorded: boolean;
  requirements: {
    serviceType: string | null;
    destination: string | null;
    dateFrom: string | null;
    passengersTotal: number | null;
    budgetState: 'known' | 'undetermined' | null;
  };
  offerPrepDueAt: string | null;
  sentOfferVersionId: string | null;
  payment: { amountMinor: bigint | null; currency: string | null; dueAt: string | null; acceptedOfferId: string | null };
  order: { exists: boolean; agreedAmountSet: boolean; saleEvidence: boolean };
  lostReasonCode: string | null;
  followUp: { nextContactAt: string | null; note: string | null };
}

export type MissingField = string;

export function requiredFieldsMissing(target: Stage, f: LeadFacts): MissingField[] {
  const missing: string[] = [];
  const need = (cond: boolean, field: string) => {
    if (!cond) missing.push(field);
  };
  switch (target) {
    case 'NEW':
      need(f.hasContactOrIdentifier, 'contact');
      need(f.hasSource, 'source');
      need(!!f.ownerId, 'owner');
      break;
    case 'CONTACTED':
      need(f.contactOutcomeRecorded, 'contact_outcome');
      break;
    case 'QUALIFIED':
      need(!!f.requirements.serviceType, 'requirements.service_type');
      need(!!f.requirements.destination, 'requirements.destination');
      need(!!f.requirements.dateFrom, 'requirements.date_from');
      need((f.requirements.passengersTotal ?? 0) > 0, 'requirements.passengers');
      need(f.requirements.budgetState !== null, 'requirements.budget_state');
      break;
    case 'PREPARING_OFFER':
      need(!!f.ownerId, 'owner');
      need(!!f.offerPrepDueAt, 'offer_prep_due_at');
      break;
    case 'OFFER_SENT':
      need(!!f.sentOfferVersionId, 'offer.sent_version');
      break;
    case 'AWAITING_PAYMENT':
      need(f.payment.amountMinor !== null, 'payment.amount');
      need(!!f.payment.currency, 'payment.currency');
      need(!!f.payment.dueAt, 'payment.due_at');
      need(!!f.payment.acceptedOfferId, 'payment.accepted_offer');
      break;
    case 'WON':
      need(f.order.exists, 'order');
      need(f.order.agreedAmountSet, 'order.agreed_amount');
      need(f.order.saleEvidence, 'order.sale_evidence');
      break;
    case 'LOST':
      need(!!f.lostReasonCode, 'lost_reason_code');
      break;
    case 'FOLLOW_UP':
      need(!!f.followUp.nextContactAt, 'follow_up.next_contact_at');
      need(!!f.followUp.note, 'follow_up.note');
      need(!!f.ownerId, 'owner');
      break;
  }
  return missing;
}

export type TransitionCheck =
  | { ok: true; returnStage: Stage | null }
  | { ok: false; code: 'SAME_STAGE' | 'CLOSED_REQUIRES_REOPEN' | 'MISSING_FIELDS' | 'INVALID_RETURN'; missing?: string[] };

/**
 * Validates a user-initiated transition in the web app. Closed leads may only be reopened through
 * the explicit reopen action (head/admin with reason).
 */
export function checkTransition(from: Stage, to: Stage, facts: LeadFacts, currentReturnStage: Stage | null): TransitionCheck {
  if (from === to) return { ok: false, code: 'SAME_STAGE' };
  if (isClosed(from)) return { ok: false, code: 'CLOSED_REQUIRES_REOPEN' };
  const missing = requiredFieldsMissing(to, facts);
  if (missing.length) return { ok: false, code: 'MISSING_FIELDS', missing };
  if (to === 'FOLLOW_UP') return { ok: true, returnStage: from };
  if (from === 'FOLLOW_UP') return { ok: true, returnStage: null };
  void currentReturnStage;
  return { ok: true, returnStage: null };
}

/** Stage the lead goes back to when communication resumes from FOLLOW_UP. */
export function resumeFromFollowUp(returnStage: Stage | null): Stage {
  if (!returnStage || isClosed(returnStage) || returnStage === 'FOLLOW_UP') return 'CONTACTED';
  return returnStage;
}

/**
 * For stage changes that were not made through the transition checks, returns the list of missing
 * fields so the caller can record an anomaly and create a correction task (TZ §11.2, AC14).
 */
export function detectAnomaly(observedStage: Stage, facts: LeadFacts): MissingField[] {
  return requiredFieldsMissing(observedStage, facts);
}

/** Dedupe key for automation side-effects (TZ §11.2). */
export function automationKey(entityId: string, rule: string, transitionId: string): string {
  return `${entityId}:${rule}:${transitionId}`;
}
