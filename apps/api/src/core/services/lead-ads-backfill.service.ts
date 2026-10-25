import type { LeadgenEvent } from '@crm/integrations';
import { audit } from '../audit';
import { integrationActor, type CoreDeps } from '../context';
import { storeInboxEvent } from '../queue';
import { assertConnectionActive, connectionToken } from './intake.service';
import { metaLeadsFor } from '../adapters';
import type { IntegrationConnection } from '@crm/database';

interface FormCursor {
  since: string;
  after: string | null;
}

export interface BackfillResult {
  forms: Array<{ formId: string; fetched: number; newEvents: number; duplicates: number; pages: number; gap: { from: string; to: string; reason: string } | null }>;
}

/**
 * Lead Ads history re-fetch (TZ §8.3). For each mapped form: cursor pagination, a persisted
 * checkpoint (`since` + page cursor, resumable), and the same dedupe key as the webhook
 * (`leadgen:<id>`) so a lead received both ways is processed once. Periods older than the
 * retrieval window are reported as gaps — recovery of every lead is never promised.
 */
export class LeadAdsBackfillService {
  constructor(private readonly d: CoreDeps) {}

  async run(companyId: string, opts: { since?: Date; maxPagesPerForm?: number; pageSize?: number; connectionId?: string } = {}): Promise<BackfillResult> {
    const connections = await this.d.prisma.integrationConnection.findMany({ where: { companyId, provider: 'META_LEADS', disconnectedAt: null, health: { notIn: ['paused', 'disconnected'] }, ...(opts.connectionId ? { id: opts.connectionId } : {}) }, orderBy: { createdAt: 'asc' } });
    // A live Page takes precedence over historical demo connections in a mixed deployment.
    const selected = connections.some(c => c.mode === 'live') ? connections.filter(c => c.mode === 'live') : connections;
    const result: BackfillResult = { forms: [] };
    for (const conn of selected) result.forms.push(...(await this.runConnection(conn, opts)).forms);
    return result;
  }

  private async runConnection(conn: IntegrationConnection, opts: { since?: Date; maxPagesPerForm?: number; pageSize?: number }): Promise<BackfillResult> {
    const companyId = conn.companyId;
    assertConnectionActive(conn);
    const company = await this.d.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const forms = [
      ...new Set([...(conn.mode === 'demo' ? Object.keys(((company.settings ?? {}) as { leadForms?: Record<string, unknown> }).leadForms ?? {}) : []), ...((((conn.settings ?? {}) as { formIds?: string[] }).formIds) ?? [])]),
    ];
    const token = connectionToken(conn, this.d.encryptionKey);
    const now = this.d.clock.now();
    const windowStart = new Date(now.getTime() - this.d.config.metaLeadsRetentionDays * 86400_000);
    const result: BackfillResult = { forms: [] };

    for (const formId of forms) {
      const stream = `leadforms:${formId}`;
      const cp = await this.d.prisma.syncCheckpoint.findUnique({ where: { connectionId_stream: { connectionId: conn.id, stream } } });
      const cursor = (cp?.cursor as FormCursor | undefined) ?? null;
      const requestedSince = opts.since ?? (cursor ? new Date(cursor.since) : windowStart);
      const since = requestedSince < windowStart ? windowStart : requestedSince;
      const gap = requestedSince < windowStart ? { from: requestedSince.toISOString(), to: windowStart.toISOString(), reason: 'outside_retrieval_window' } : null;
      let after = !opts.since && cursor?.after ? cursor.after : null;
      let maxSeen = since;
      const stat = { formId, fetched: 0, newEvents: 0, duplicates: 0, pages: 0, gap };
      for (let page = 0; page < (opts.maxPagesPerForm ?? 500); page++) {
        const r = await metaLeadsFor(this.d.adapters, conn.mode).listFormLeads(formId, since, after, token, opts.pageSize);
        stat.pages++;
        for (const lead of r.items) {
          stat.fetched++;
          if (lead.createdTime && lead.createdTime > maxSeen) maxSeen = lead.createdTime;
          const evt: LeadgenEvent = { kind: 'leadgen', key: `leadgen:${lead.leadgenId}`, pageId: conn.accountId, leadgenId: lead.leadgenId, formId: lead.formId ?? formId, adId: lead.adId, adgroupId: lead.adsetId, createdTime: lead.createdTime };
          const stored = await storeInboxEvent(this.d.prisma, this.d.encryptionKey, { provider: 'meta', connectionKey: conn.accountId, companyId, externalEventId: evt.key, eventType: 'leadgen', payload: evt, correlationId: `backfill:${formId}` });
          if (stored) stat.newEvents++;
          else stat.duplicates++;
        }
        after = r.after;
        // Resumable: an interruption continues from this page cursor.
        await this.saveCursor(conn.id, companyId, stream, { since: since.toISOString(), after }, null);
        if (!after) break;
      }
      // When the page budget is exhausted, keep the cursor instead of silently skipping the rest.
      await this.saveCursor(conn.id, companyId, stream, after ? { since: since.toISOString(), after } : { since: new Date(Math.max(since.getTime(), maxSeen.getTime() - 1000)).toISOString(), after: null }, stat);
      result.forms.push(stat);
    }
    await audit(this.d.prisma, integrationActor(companyId, 'meta_lead_ads'), { entityType: 'integration', entityId: conn.id, action: 'lead_ads_backfill', newValue: result });
    return result;
  }

  private async saveCursor(connectionId: string, companyId: string, stream: string, cursor: FormCursor, lastResult: object | null) {
    const now = this.d.clock.now();
    await this.d.prisma.syncCheckpoint.upsert({
      where: { connectionId_stream: { connectionId, stream } },
      create: { companyId, connectionId, stream, cursor: cursor as object, lastRunAt: now, ...(lastResult ? { lastResult } : {}) },
      update: { cursor: cursor as object, lastRunAt: now, ...(lastResult ? { lastResult } : {}) },
    });
  }
}
