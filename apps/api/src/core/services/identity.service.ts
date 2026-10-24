import type { Tx } from '@crm/database';
import { decideContactMatch, type IncomingIdentifier, type KnownIdentifier, type MatchDecision } from '@crm/domain';

/**
 * Contact identification with DB-level concurrency protection (TZ §7.2 step 6):
 * transaction-scoped advisory locks on every incoming identifier key, taken in sorted order,
 * plus the partial unique index on active Instagram scoped IDs.
 */

export interface IdentifyInput {
  companyId: string;
  identifiers: Array<IncomingIdentifier & { verified: boolean; originalValue?: string | null; displayUsername?: string | null }>;
  fullName: string | null;
  primaryPhone: string | null;
  primaryEmail: string | null;
}

export interface IdentifyResult {
  contactId: string;
  created: boolean;
  decision: MatchDecision['kind'];
  reviewCount: number;
}

export async function lockIdentifiers(tx: Tx, companyId: string, ids: IncomingIdentifier[]): Promise<void> {
  const keys = [...new Set(ids.map((i) => `${companyId}|${i.type}|${i.scope}|${i.value}`))].sort();
  for (const k of keys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${k}, 0))`;
}

export async function identifyContact(tx: Tx, input: IdentifyInput): Promise<IdentifyResult> {
  const incoming = input.identifiers.filter((i) => i.value);
  await lockIdentifiers(tx, input.companyId, incoming);

  const knownRows = incoming.length
    ? await tx.contactIdentifier.findMany({
        where: {
          companyId: input.companyId,
          active: true,
          OR: incoming.map((i) => ({ type: i.type, scope: i.scope, value: i.value })),
        },
        include: { contact: { select: { deletedAt: true, mergedIntoId: true } } },
      })
    : [];
  const known: KnownIdentifier[] = knownRows
    .filter((r) => !r.contact.deletedAt)
    .map((r) => ({ type: r.type as KnownIdentifier['type'], value: r.value, scope: r.scope, contactId: r.contact.mergedIntoId ?? r.contactId, verified: r.verified, shared: r.shared }));

  const decision = decideContactMatch(incoming, known);
  let contactId: string;
  let created = false;
  if (decision.kind === 'create') {
    const c = await tx.contact.create({
      data: { companyId: input.companyId, fullName: input.fullName, primaryPhone: input.primaryPhone, primaryEmail: input.primaryEmail, syncState: 'pending_create' },
    });
    contactId = c.id;
    created = true;
  } else {
    contactId = decision.contactId;
  }

  // Attach identifiers that are new for this contact and not under review.
  const reviewed = new Set(decision.review.map((r) => `${r.identifier.type}|${r.identifier.scope}|${r.identifier.value}`));
  for (const i of incoming) {
    const k = `${i.type}|${i.scope}|${i.value}`;
    const already = knownRows.some((r) => r.contactId === contactId && r.type === i.type && r.scope === i.scope && r.value === i.value);
    if (already) {
      if (i.displayUsername) {
        await tx.contactIdentifier.updateMany({ where: { companyId: input.companyId, contactId, type: i.type, scope: i.scope, value: i.value }, data: { displayUsername: i.displayUsername } });
      }
      continue;
    }
    if (reviewed.has(k) && i.type === 'instagram_scoped') continue;
    const sharedElsewhere = knownRows.some((r) => r.type === i.type && r.scope === i.scope && r.value === i.value && r.shared);
    await tx.contactIdentifier.create({
      data: {
        companyId: input.companyId,
        contactId,
        type: i.type,
        value: i.value,
        scope: i.scope,
        verified: i.verified,
        shared: sharedElsewhere || reviewed.has(k),
        originalValue: i.originalValue ?? null,
        displayUsername: i.displayUsername ?? null,
      },
    });
  }

  for (const r of decision.review) {
    await tx.duplicateCandidate.create({
      data: {
        companyId: input.companyId,
        contactIds: [...new Set([contactId, ...r.candidateContactIds])],
        reason: r.reason,
        identifier: { type: r.identifier.type, scope: r.identifier.scope, value: r.identifier.value },
      },
    });
  }
  return { contactId, created, decision: decision.kind, reviewCount: decision.review.length };
}
