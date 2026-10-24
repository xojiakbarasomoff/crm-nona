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
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS_UZ: Record<Stage, string> = {
  NEW: 'Yangi lid',
  CONTACTED: 'Mijoz bilan aloqa o‘rnatildi',
  QUALIFIED: 'Mijoz talablari aniqlandi',
  PREPARING_OFFER: 'Taklif tayyorlanmoqda',
  OFFER_SENT: 'Taklif mijozga yuborildi',
  AWAITING_PAYMENT: 'To‘lov kutilmoqda',
  WON: 'Sotuv muvaffaqiyatli yakunlandi',
  LOST: 'Bekor qilindi',
  FOLLOW_UP: 'Qayta aloqa talab qilinadi',
};

export const CLOSED_STAGES: ReadonlySet<Stage> = new Set(['WON', 'LOST']);
export const isClosed = (s: Stage) => CLOSED_STAGES.has(s);
export const isOpen = (s: Stage) => !CLOSED_STAGES.has(s);

export const SERVICE_TYPES = ['avia', 'tour_package', 'hotel', 'visa', 'other'] as const;
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
 * For stage changes observed from amoCRM (which we cannot block), returns the list of missing
 * fields so the caller can record an anomaly and create a correction task (TZ §11.2, AC14).
 */
export function detectAnomaly(observedStage: Stage, facts: LeadFacts): MissingField[] {
  return requiredFieldsMissing(observedStage, facts);
}

/** Dedupe key for automation side-effects (TZ §11.2). */
export function automationKey(entityId: string, rule: string, transitionId: string): string {
  return `${entityId}:${rule}:${transitionId}`;
}
