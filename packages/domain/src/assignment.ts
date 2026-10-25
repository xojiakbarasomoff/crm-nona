import { isWithinSchedule, type WeeklySchedule } from './schedule';

/**
 * Lead assignment (TZ §10). The strategy interface allows weighted/service-type strategies later;
 * the first version ships equal round-robin only.
 */

export const ASSIGNMENT_ALGORITHM_VERSION = 'rr-equal-v1';

export interface PoolMember {
  userId: string;
  /** Stable order inside the pool (position). */
  position: number;
  active: boolean;
  available: boolean;
  schedule: WeeklySchedule | null;
  serviceTypes: string[] | null;
}

export interface AssignmentStrategy {
  readonly version: string;
  pick(members: PoolMember[], pointer: number, ctx: { at: Date; serviceType: string | null }): { userId: string; nextPointer: number } | null;
}

export function isEligible(m: PoolMember, at: Date, serviceType: string | null): boolean {
  if (!m.active || !m.available) return false;
  if (!isWithinSchedule(m.schedule, at)) return false;
  if (serviceType && m.serviceTypes && m.serviceTypes.length > 0 && !m.serviceTypes.includes(serviceType)) return false;
  return true;
}

/**
 * Pointer = position of the last assigned member. The next eligible member strictly after the pointer
 * (cyclically) is picked. Ineligible members are skipped without losing their turn order.
 */
export const equalRoundRobin: AssignmentStrategy = {
  version: ASSIGNMENT_ALGORITHM_VERSION,
  pick(members, pointer, { at, serviceType }) {
    const sorted = [...members].sort((a, b) => a.position - b.position);
    if (sorted.length === 0) return null;
    let start = sorted.findIndex((m) => m.position > pointer);
    if (start === -1) start = 0;
    for (let i = 0; i < sorted.length; i++) {
      const m = sorted[(start + i) % sorted.length]!;
      if (isEligible(m, at, serviceType)) return { userId: m.userId, nextPointer: m.position };
    }
    return null;
  },
};

export type AssignmentReason =
  | 'existing_active_lead'
  | 'sticky_owner'
  | 'round_robin'
  | 'awaiting_assignment'
  | 'duty_fallback';

export interface AssignmentInput {
  existingActiveLeadOwnerId: string | null;
  contactOwner: { userId: string; eligible: boolean } | null;
  stickyOwnerEnabled: boolean;
  roundRobinPick: { userId: string; nextPointer: number } | null;
  /** When nobody is eligible: the company duty user receives the lead. */
  dutyUserId: string | null;
}

export interface AssignmentDecision {
  userId: string | null;
  reason: AssignmentReason;
  nextPointer: number | null;
  /** True when the decision should also raise a signal to the head of sales. */
  alertHead: boolean;
}

export function decideAssignment(input: AssignmentInput): AssignmentDecision {
  if (input.existingActiveLeadOwnerId) {
    return { userId: input.existingActiveLeadOwnerId, reason: 'existing_active_lead', nextPointer: null, alertHead: false };
  }
  if (input.stickyOwnerEnabled && input.contactOwner?.eligible) {
    return { userId: input.contactOwner.userId, reason: 'sticky_owner', nextPointer: null, alertHead: false };
  }
  if (input.roundRobinPick) {
    return { userId: input.roundRobinPick.userId, reason: 'round_robin', nextPointer: input.roundRobinPick.nextPointer, alertHead: false };
  }
  if (input.dutyUserId) return { userId: input.dutyUserId, reason: 'duty_fallback', nextPointer: null, alertHead: true };
  return { userId: null, reason: 'awaiting_assignment', nextPointer: null, alertHead: true };
}
