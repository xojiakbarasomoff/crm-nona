/**
 * Contact identification rules (TZ §7.2).
 *
 * 1. An existing exact provider-ID mapping wins.
 * 2. Otherwise candidates are looked up by normalized, verified identifiers.
 * 3. Exactly one non-conflicting candidate → link.
 * 4. Phone vs Instagram pointing to different contacts, or a shared/family phone → no auto-merge;
 *    a review record is created.
 * 5. Name/username similarity never causes a merge (usernames are not inputs here at all).
 */

export type IdentifierType = 'instagram_scoped' | 'phone' | 'email';

/** Identifiers that are stable provider keys and can be mapped 1:1 to a contact. */
export const PROVIDER_KEY_TYPES: ReadonlySet<IdentifierType> = new Set(['instagram_scoped']);

export interface IncomingIdentifier {
  type: IdentifierType;
  /** Normalized value (E.164 phone, lower-cased email, scoped sender id). */
  value: string;
  /** Scope, e.g. Instagram business_account_id. Empty string for global identifiers. */
  scope: string;
}

export interface KnownIdentifier extends IncomingIdentifier {
  contactId: string;
  verified: boolean;
  shared: boolean;
}

export type MatchDecision =
  | { kind: 'mapped'; contactId: string; review: ReviewItem[] }
  | { kind: 'linked'; contactId: string; review: ReviewItem[] }
  | { kind: 'create'; review: ReviewItem[] };

export interface ReviewItem {
  reason: 'phone_points_to_other_contact' | 'shared_identifier' | 'multiple_candidates' | 'conflicting_provider_id';
  candidateContactIds: string[];
  identifier: IncomingIdentifier;
}

const key = (i: IncomingIdentifier) => `${i.type}|${i.scope}|${i.value}`;

export function decideContactMatch(incoming: IncomingIdentifier[], known: KnownIdentifier[]): MatchDecision {
  const byKey = new Map<string, KnownIdentifier[]>();
  for (const k of known) {
    const list = byKey.get(key(k)) ?? [];
    list.push(k);
    byKey.set(key(k), list);
  }
  const review: ReviewItem[] = [];

  // Step 1: exact provider mapping.
  const providerHits = new Set<string>();
  for (const inc of incoming) {
    if (!PROVIDER_KEY_TYPES.has(inc.type)) continue;
    for (const hit of byKey.get(key(inc)) ?? []) providerHits.add(hit.contactId);
  }
  if (providerHits.size > 1) {
    // Should be impossible thanks to the DB constraint; treat as a data problem, do not merge.
    review.push({
      reason: 'conflicting_provider_id',
      candidateContactIds: [...providerHits],
      identifier: incoming.find((i) => PROVIDER_KEY_TYPES.has(i.type))!,
    });
  }
  if (providerHits.size >= 1) {
    const contactId = [...providerHits][0]!;
    for (const inc of incoming) {
      if (PROVIDER_KEY_TYPES.has(inc.type)) continue;
      const others = (byKey.get(key(inc)) ?? []).filter((k) => k.contactId !== contactId).map((k) => k.contactId);
      if (others.length) review.push({ reason: 'phone_points_to_other_contact', candidateContactIds: unique([contactId, ...others]), identifier: inc });
    }
    return { kind: 'mapped', contactId, review };
  }

  // Step 2: candidates by verified, non-shared secondary identifiers.
  const candidates = new Set<string>();
  for (const inc of incoming) {
    if (PROVIDER_KEY_TYPES.has(inc.type)) continue;
    const hits = byKey.get(key(inc)) ?? [];
    const shared = hits.filter((h) => h.shared);
    const usable = hits.filter((h) => !h.shared && h.verified);
    if (shared.length || unique(hits.map((h) => h.contactId)).length > 1) {
      review.push({ reason: 'shared_identifier', candidateContactIds: unique(hits.map((h) => h.contactId)), identifier: inc });
      continue;
    }
    for (const h of usable) candidates.add(h.contactId);
  }

  if (candidates.size === 0) return { kind: 'create', review };
  if (candidates.size > 1) {
    review.push({ reason: 'multiple_candidates', candidateContactIds: [...candidates], identifier: incoming[0]! });
    return { kind: 'create', review };
  }

  const contactId = [...candidates][0]!;
  // Step 4: candidate already owns a *different* provider key in the same scope → conflict.
  for (const inc of incoming) {
    if (!PROVIDER_KEY_TYPES.has(inc.type)) continue;
    const conflicting = known.some(
      (k) => k.contactId === contactId && k.type === inc.type && k.scope === inc.scope && k.value !== inc.value,
    );
    if (conflicting) {
      review.push({ reason: 'phone_points_to_other_contact', candidateContactIds: [contactId], identifier: inc });
      return { kind: 'create', review };
    }
  }
  return { kind: 'linked', contactId, review };
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
