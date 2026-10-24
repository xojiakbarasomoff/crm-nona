import type { Tx } from '@crm/database';
import { decideAssignment, equalRoundRobin, isEligible, type AssignmentDecision, type PoolMember, type WeeklySchedule } from '@crm/domain';

/**
 * Atomic round-robin (TZ §10): the pool row is locked with SELECT … FOR UPDATE inside the caller's
 * transaction, so 100 concurrent leads cannot corrupt the pointer.
 */
export async function assignNewLead(
  tx: Tx,
  p: { companyId: string; contactId: string; serviceType: string | null; at: Date },
): Promise<AssignmentDecision & { poolId: string | null; algorithm: string }> {
  const company = await tx.company.findUniqueOrThrow({ where: { id: p.companyId } });
  const settings = (company.settings ?? {}) as { amoRequiresResponsible?: boolean };

  const contact = await tx.contact.findUnique({ where: { id: p.contactId }, select: { ownerId: true } });

  const pools = await tx.$queryRaw<Array<{ id: string; pointer: number; service_type: string | null }>>`
    SELECT id, pointer, service_type FROM manager_pools
    WHERE company_id = ${p.companyId}::uuid AND active
      AND (service_type = ${p.serviceType} OR (service_type IS NULL AND is_default))
    ORDER BY (service_type IS NULL) ASC
    LIMIT 1
    FOR UPDATE`;
  const pool = pools[0] ?? null;

  let members: PoolMember[] = [];
  if (pool) {
    const rows = await tx.managerPoolMember.findMany({ where: { poolId: pool.id }, orderBy: { position: 'asc' } });
    const users = await tx.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, status: true } });
    const active = new Map(users.map((u) => [u.id, u.status === 'active']));
    members = rows.map((r) => ({
      userId: r.userId,
      position: r.position,
      active: active.get(r.userId) ?? false,
      available: r.available,
      schedule: (r.schedule as WeeklySchedule | null) ?? null,
      serviceTypes: r.serviceTypes,
    }));
  }

  const ownerMember = contact?.ownerId ? members.find((m) => m.userId === contact.ownerId) : undefined;
  const pick = pool ? equalRoundRobin.pick(members, pool.pointer, { at: p.at, serviceType: p.serviceType }) : null;
  const decision = decideAssignment({
    existingActiveLeadOwnerId: null,
    contactOwner: contact?.ownerId ? { userId: contact.ownerId, eligible: !!ownerMember && isEligible(ownerMember, p.at, p.serviceType) } : null,
    stickyOwnerEnabled: company.stickyOwner,
    roundRobinPick: pick,
    dutyUserId: settings.amoRequiresResponsible === false ? null : company.dutyUserId,
  });
  if (pool && decision.reason === 'round_robin' && decision.nextPointer !== null) {
    await tx.managerPool.update({ where: { id: pool.id }, data: { pointer: decision.nextPointer } });
  }
  return { ...decision, poolId: pool?.id ?? null, algorithm: equalRoundRobin.version };
}
