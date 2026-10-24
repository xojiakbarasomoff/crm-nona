import type { IntegrationConnection, Prisma } from '@crm/database';
import { isClosed, normalizeEmail, normalizePhone, stateHash, type CompanyPhoneRule, type Stage } from '@crm/domain';
import type { AmoContactSnapshot, AmoLeadSnapshot, AmoRestClient } from '@crm/integrations';
import { audit } from '../audit';
import { integrationActor, type CoreDeps } from '../context';
import { LeadsService, leadStateHash } from './leads.service';

const OVERLAP_MS = 10 * 60_000;

/**
 * amoCRM → local projection jobs (TZ §5.2):
 * - initial import of users mapping, contacts and active leads (resumable page checkpoints, idempotent);
 * - incremental reconciliation every 5 minutes with ≥10 minute overlap (leads and contacts),
 *   including leads created natively in amoCRM;
 * - daily control: detects leads deleted in amoCRM (tombstone, never re-created) and active
 *   amoCRM leads missing locally (imported).
 */
export class AmoSyncService {
  private readonly leads: LeadsService;
  constructor(private readonly d: CoreDeps) {
    this.leads = new LeadsService(d);
  }

  private async connection(companyId: string) {
    return this.d.prisma.integrationConnection.findFirstOrThrow({ where: { companyId, provider: 'AMOCRM_REST', disconnectedAt: null } });
  }

  private async checkpoint<T>(conn: IntegrationConnection, stream: string): Promise<T | null> {
    const cp = await this.d.prisma.syncCheckpoint.findUnique({ where: { connectionId_stream: { connectionId: conn.id, stream } } });
    return (cp?.cursor as T | undefined) ?? null;
  }

  private async saveCheckpoint(conn: IntegrationConnection, stream: string, cursor: object, lastResult?: object) {
    const now = this.d.clock.now();
    await this.d.prisma.syncCheckpoint.upsert({
      where: { connectionId_stream: { connectionId: conn.id, stream } },
      create: { companyId: conn.companyId, connectionId: conn.id, stream, cursor, lastRunAt: now, ...(lastResult ? { lastResult } : {}) },
      update: { cursor, lastRunAt: now, ...(lastResult ? { lastResult } : {}) },
    });
  }

  // ---------------- Upserts ----------------

  async upsertContact(conn: IntegrationConnection, snap: AmoContactSnapshot): Promise<'created' | 'updated' | 'unchanged' | 'tombstoned'> {
    const companyId = conn.companyId;
    const company = await this.d.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const phone = snap.phones.map((p) => normalizePhone(p, company.phoneRule as CompanyPhoneRule | null)).find((p) => p.status === 'ok');
    const email = snap.emails.map(normalizeEmail).find(Boolean) ?? null;
    const owner = snap.responsibleUserId ? await this.d.prisma.user.findFirst({ where: { companyId, amoUserId: snap.responsibleUserId }, select: { id: true } }) : null;
    const existing = await this.d.prisma.contact.findFirst({ where: { companyId, amoContactId: snap.id } });
    if (existing) {
      if (existing.piiErasedAt) return 'unchanged'; // never re-import erased PII
      if (snap.deleted) {
        if (existing.deletedAt) return 'unchanged';
        await this.d.prisma.contact.update({ where: { id: existing.id }, data: { deletedAt: this.d.clock.now(), syncState: 'synced' } });
        return 'tombstoned';
      }
      if (existing.sourceUpdatedAt && existing.sourceUpdatedAt >= snap.updatedAt) return 'unchanged';
      await this.d.prisma.contact.update({
        where: { id: existing.id },
        data: { fullName: snap.name, primaryPhone: phone?.status === 'ok' ? phone.normalized : existing.primaryPhone, primaryEmail: email ?? existing.primaryEmail, ownerId: owner?.id ?? existing.ownerId, sourceUpdatedAt: snap.updatedAt, syncState: 'synced', version: { increment: 1 } },
      });
      return 'updated';
    }
    if (snap.deleted) return 'unchanged';
    await this.d.prisma.$transaction(async (tx) => {
      const c = await tx.contact.create({
        data: { companyId, amoContactId: snap.id, fullName: snap.name, primaryPhone: phone?.status === 'ok' ? phone.normalized : null, primaryEmail: email, ownerId: owner?.id ?? null, syncState: 'synced', sourceUpdatedAt: snap.updatedAt },
      });
      const idents: Prisma.ContactIdentifierCreateManyInput[] = [];
      if (phone?.status === 'ok') idents.push({ companyId, contactId: c.id, type: 'phone', value: phone.normalized, originalValue: phone.original, verified: true });
      if (email) idents.push({ companyId, contactId: c.id, type: 'email', value: email, verified: true });
      if (idents.length) await tx.contactIdentifier.createMany({ data: idents });
      await tx.integrationMapping.createMany({ data: [{ companyId, connectionId: conn.id, entityType: 'contact', localId: c.id, externalId: snap.id, lastSyncedAt: this.d.clock.now(), sourceUpdatedAt: snap.updatedAt }], skipDuplicates: true });
    });
    return 'created';
  }

  async upsertLead(conn: IntegrationConnection, client: AmoRestClient, snap: AmoLeadSnapshot, opts: { onlyActive: boolean }): Promise<'created' | 'applied' | 'stale' | 'skipped_closed' | 'skipped_unmapped' | 'skipped_no_contact' | 'tombstoned'> {
    const companyId = conn.companyId;
    const existing = await this.d.prisma.lead.findFirst({ where: { companyId, amoLeadId: snap.id }, select: { id: true } });
    if (existing) {
      const r = await this.d.prisma.$transaction((tx) => this.leads.applyRemoteSnapshot(tx, companyId, snap, { origin: 'reconcile' }));
      return r.reason === 'tombstoned' ? 'tombstoned' : r.applied ? 'applied' : 'stale';
    }
    if (snap.deleted) return 'skipped_closed';
    const stage = await this.leads.stageForStatus(this.d.prisma, companyId, snap.pipelineId, snap.statusId);
    if (!stage) return 'skipped_unmapped';
    if (opts.onlyActive && isClosed(stage)) return 'skipped_closed';
    const amoContactId = snap.contactIds[0];
    if (!amoContactId) return 'skipped_no_contact';
    let contact = await this.d.prisma.contact.findFirst({ where: { companyId, amoContactId } });
    if (!contact) {
      const c = await client.getContact(amoContactId);
      if (!c) return 'skipped_no_contact';
      await this.upsertContact(conn, c);
      contact = await this.d.prisma.contact.findFirst({ where: { companyId, amoContactId } });
      if (!contact) return 'skipped_no_contact';
    }
    const owner = snap.responsibleUserId ? await this.d.prisma.user.findFirst({ where: { companyId, amoUserId: snap.responsibleUserId }, select: { id: true } }) : null;
    const createdAt = snap.createdAt ?? snap.updatedAt;
    await this.d.prisma.$transaction(async (tx) => {
      const lead = await tx.lead.create({
        data: {
          companyId,
          amoLeadId: snap.id,
          contactId: contact!.id,
          name: snap.name || 'amoCRM lid',
          stage: stage as Stage,
          ownerId: owner?.id ?? null,
          assignmentReason: 'imported_from_amocrm',
          firstSource: 'amocrm',
          syncState: 'synced',
          sourceUpdatedAt: snap.updatedAt,
          stateHash: leadStateHash({ stage: stage as Stage, ownerId: owner?.id ?? null }),
          closedAt: isClosed(stage) ? (snap.closedAt ?? snap.updatedAt) : null,
          firstWonAt: stage === 'WON' ? (snap.closedAt ?? snap.updatedAt) : null,
          // Imported leads were handled before data collection; they do not count as SLA breaches.
          firstHumanActionAt: createdAt,
          createdAt,
        },
      });
      await tx.leadEvent.create({ data: { companyId, leadId: lead.id, kind: 'imported', newStage: stage as Stage, newOwnerId: owner?.id ?? null, origin: 'amocrm', effectiveAt: createdAt } });
      await tx.integrationMapping.createMany({ data: [{ companyId, connectionId: conn.id, entityType: 'lead', localId: lead.id, externalId: snap.id, lastSyncedAt: this.d.clock.now(), sourceUpdatedAt: snap.updatedAt, stateHash: stateHash({ stage }) }], skipDuplicates: true });
      await audit(tx, integrationActor(companyId, 'amocrm_import'), { entityType: 'lead', entityId: lead.id, action: 'imported', newValue: { amoLeadId: snap.id, stage } });
    });
    return 'created';
  }

  // ---------------- Jobs ----------------

  /** Resumable initial import; re-running after an interruption continues from the saved page. */
  async importInitial(companyId: string, opts: { pageSize?: number; maxPages?: number } = {}) {
    const conn = await this.connection(companyId);
    const client = this.d.adapters.amoRest(conn);
    const size = opts.pageSize ?? 250;
    const maxPages = opts.maxPages ?? 10_000;
    const result = { users: { matched: 0, unmatched: [] as string[] }, contacts: {} as Record<string, number>, leads: {} as Record<string, number> };
    const count = (bucket: Record<string, number>, k: string) => (bucket[k] = (bucket[k] ?? 0) + 1);

    for (const u of await client.listUsers()) {
      const local = u.email ? await this.d.prisma.user.findFirst({ where: { companyId, email: u.email.toLowerCase() } }) : null;
      if (local && !local.amoUserId) {
        await this.d.prisma.user.update({ where: { id: local.id }, data: { amoUserId: u.id } });
        result.users.matched++;
      } else if (!local) result.users.unmatched.push(`${u.name} (${u.id})`);
    }

    for (const stream of ['contacts', 'leads'] as const) {
      const cp = (await this.checkpoint<{ page: number; done: boolean }>(conn, `import:${stream}`)) ?? { page: 1, done: false };
      if (cp.done) continue;
      let page = cp.page;
      for (let i = 0; i < maxPages; i++) {
        const r = stream === 'contacts' ? await client.listContactsUpdatedSince(new Date(0), page, size) : await client.listLeadsUpdatedSince(new Date(0), page, size);
        for (const item of r.items) {
          if (stream === 'contacts') count(result.contacts, await this.upsertContact(conn, item as AmoContactSnapshot));
          else count(result.leads, await this.upsertLead(conn, client, item as AmoLeadSnapshot, { onlyActive: true }));
        }
        page++;
        await this.saveCheckpoint(conn, `import:${stream}`, { page, done: !r.hasMore });
        if (!r.hasMore) break;
      }
    }
    await audit(this.d.prisma, integrationActor(companyId, 'amocrm_import'), { entityType: 'integration', entityId: conn.id, action: 'initial_import', newValue: result });
    return result;
  }

  /** Incremental reconciliation with checkpoint and overlap; idempotent for repeated records. */
  async reconcile(conn: IntegrationConnection, opts: { pageSize?: number; maxPages?: number } = {}) {
    const client = this.d.adapters.amoRest(conn);
    const size = opts.pageSize ?? 250;
    const out: Record<string, Record<string, number>> = { leads: {}, contacts: {} };
    for (const stream of ['contacts', 'leads'] as const) {
      const startedAt = this.d.clock.now();
      const cp = await this.checkpoint<{ since?: string }>(conn, stream);
      const since = new Date((cp?.since ? Date.parse(cp.since) : startedAt.getTime() - 24 * 3600_000) - OVERLAP_MS);
      for (let page = 1; page <= (opts.maxPages ?? 200); page++) {
        const r = stream === 'contacts' ? await client.listContactsUpdatedSince(since, page, size) : await client.listLeadsUpdatedSince(since, page, size);
        for (const item of r.items) {
          const k = stream === 'contacts' ? await this.upsertContact(conn, item as AmoContactSnapshot) : await this.upsertLead(conn, client, item as AmoLeadSnapshot, { onlyActive: true });
          out[stream]![k] = (out[stream]![k] ?? 0) + 1;
        }
        if (!r.hasMore) break;
      }
      await this.saveCheckpoint(conn, stream, { since: startedAt.toISOString() }, out[stream]);
    }
    await this.d.prisma.integrationConnection.update({ where: { id: conn.id }, data: { lastSyncAt: this.d.clock.now() } });
    return out;
  }

  /** Daily control: deleted-in-amoCRM detection and missing active leads. */
  async dailyAudit(conn: IntegrationConnection, opts: { pageSize?: number; maxPages?: number } = {}) {
    const client = this.d.adapters.amoRest(conn);
    const size = opts.pageSize ?? 250;
    const remote = new Set<string>();
    const result = { remoteSeen: 0, localChecked: 0, tombstoned: 0, imported: 0, truncated: false };
    let page = 1;
    for (; page <= (opts.maxPages ?? 1000); page++) {
      const r = await client.listLeadsUpdatedSince(new Date(0), page, size);
      for (const snap of r.items) {
        remote.add(snap.id);
        if ((await this.upsertLead(conn, client, snap, { onlyActive: true })) === 'created') result.imported++;
      }
      if (!r.hasMore) break;
    }
    if (page > (opts.maxPages ?? 1000)) result.truncated = true;
    result.remoteSeen = remote.size;
    if (!result.truncated) {
      const local = await this.d.prisma.lead.findMany({ where: { companyId: conn.companyId, amoLeadId: { not: null }, deletedAt: null }, select: { amoLeadId: true, name: true } });
      for (const l of local) {
        if (remote.has(l.amoLeadId!)) continue;
        result.localChecked++;
        const snap = await client.getLead(l.amoLeadId!);
        if (!snap || snap.deleted) {
          const tomb: AmoLeadSnapshot = { id: l.amoLeadId!, name: l.name, pipelineId: '', statusId: '', responsibleUserId: null, price: null, updatedAt: this.d.clock.now(), createdAt: null, closedAt: null, contactIds: [], customFields: {}, deleted: true };
          await this.d.prisma.$transaction((tx) => this.leads.applyRemoteSnapshot(tx, conn.companyId, tomb, { origin: 'reconcile' }));
          result.tombstoned++;
        }
      }
    }
    await this.saveCheckpoint(conn, 'daily_audit', { at: this.d.clock.now().toISOString() }, result);
    return result;
  }

  /** Worker helper: runs the daily audit at most once per 24 h per connection. */
  async dailyAuditIfDue(conn: IntegrationConnection) {
    const cp = await this.d.prisma.syncCheckpoint.findUnique({ where: { connectionId_stream: { connectionId: conn.id, stream: 'daily_audit' } } });
    if (cp?.lastRunAt && this.d.clock.now().getTime() - cp.lastRunAt.getTime() < 24 * 3600_000) return null;
    return this.dailyAudit(conn);
  }
}
