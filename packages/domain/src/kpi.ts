/**
 * KPI formulas (TZ §15.1). All functions are pure; callers supply already-filtered facts.
 */

export type Ratio = { value: number; display: string } | { value: null; display: '—' };

export function percent(numerator: number, denominator: number): Ratio {
  if (denominator === 0) return { value: null, display: '—' };
  const value = Math.round((numerator / denominator) * 10000) / 100;
  return { value, display: `${value.toFixed(1)}%` };
}

export interface LeadFact {
  id: string;
  createdAt: Date;
  /** Current stage. */
  stage: string;
  /** First time the lead reached WON (dedupe: re-closing does not count twice). */
  firstWonAt: Date | null;
  /** Most recent close event inside the data (WON or LOST) with its timestamp. */
  closes: Array<{ stage: 'WON' | 'LOST'; at: Date }>;
}

const inRange = (d: Date, start: Date, end: Date) => d.getTime() >= start.getTime() && d.getTime() < end.getTime();

/** Leads created in period that are WON now / all leads created in period. */
export function cohortConversion(leads: LeadFact[], start: Date, end: Date): Ratio & { numerator: number; denominator: number } {
  const cohort = leads.filter((l) => inRange(l.createdAt, start, end));
  const won = cohort.filter((l) => l.stage === 'WON').length;
  return { ...percent(won, cohort.length), numerator: won, denominator: cohort.length };
}

/**
 * Of leads closed in the period: WON / (WON + LOST). Each lead counts once, by its last close
 * inside the period.
 */
export function closedConversion(leads: LeadFact[], start: Date, end: Date): Ratio & { numerator: number; denominator: number } {
  let won = 0;
  let lost = 0;
  for (const l of leads) {
    const last = l.closes.filter((c) => inRange(c.at, start, end)).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    if (!last) continue;
    if (last.stage === 'WON') won++;
    else lost++;
  }
  return { ...percent(won, won + lost), numerator: won, denominator: won + lost };
}

/** Unique leads that first became WON inside the period. */
export function wonInPeriod(leads: LeadFact[], start: Date, end: Date): number {
  return leads.filter((l) => l.firstWonAt && inRange(l.firstWonAt, start, end)).length;
}

export interface ConversationTiming {
  firstInboundAt: Date;
  /** First reply authored by a human (not bot, not internal note). */
  firstHumanReplyAt: Date | null;
}

export function quantile(sortedAsc: number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (pos - lo);
}

export interface FirstResponseStats {
  observed: number;
  answered: number;
  unanswered: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
}

export function firstResponseStats(items: ConversationTiming[]): FirstResponseStats {
  const durations = items
    .filter((i) => i.firstHumanReplyAt)
    .map((i) => (i.firstHumanReplyAt!.getTime() - i.firstInboundAt.getTime()) / 1000)
    .filter((s) => s >= 0)
    .sort((a, b) => a - b);
  return {
    observed: items.length,
    answered: durations.length,
    unanswered: items.length - durations.length,
    medianSeconds: quantile(durations, 0.5),
    p90Seconds: quantile(durations, 0.9),
  };
}

export interface MessageForResponse {
  direction: 'inbound' | 'outbound';
  actorType: 'customer' | 'human' | 'bot' | 'system';
  isInternalNote: boolean;
  at: Date;
}

/** Derives first inbound and first human reply; bot replies and internal notes are ignored (AC33). */
export function deriveFirstResponse(messages: MessageForResponse[]): ConversationTiming | null {
  const sorted = [...messages].sort((a, b) => a.at.getTime() - b.at.getTime());
  const firstInbound = sorted.find((m) => m.direction === 'inbound' && m.actorType === 'customer');
  if (!firstInbound) return null;
  const reply = sorted.find(
    (m) => m.direction === 'outbound' && m.actorType === 'human' && !m.isInternalNote && m.at.getTime() >= firstInbound.at.getTime(),
  );
  return { firstInboundAt: firstInbound.at, firstHumanReplyAt: reply?.at ?? null };
}

/** True when the last customer message has no human reply after it. */
export function awaitingReply(messages: MessageForResponse[]): boolean {
  const sorted = [...messages].sort((a, b) => a.at.getTime() - b.at.getTime());
  let lastCustomer: Date | null = null;
  let lastHuman: Date | null = null;
  for (const m of sorted) {
    if (m.direction === 'inbound' && m.actorType === 'customer') lastCustomer = m.at;
    if (m.direction === 'outbound' && m.actorType === 'human' && !m.isInternalNote) lastHuman = m.at;
  }
  return !!lastCustomer && (!lastHuman || lastHuman < lastCustomer);
}
