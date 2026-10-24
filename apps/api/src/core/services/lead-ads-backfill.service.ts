import type { LeadgenEvent } from '@crm/integrations';
import { audit } from '../audit';
import { integrationActor, type CoreDeps } from '../context';
import { storeInboxEvent } from '../queue';
import { assertConnectionActive, connectionToken } from './intake.service';

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

  async run(companyId: string, opts: { since?: Date; maxPagesPerForm?: number; pageSize?: number } = {}): Promise<BackfillResult> {
    const conn = await this.d.prisma.integrationConnection.findFirstOrThrow({ where: { companyId, provider: 'META_LEADS' } });
    assertConnectionActive(conn);
    const company = await this.d.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const forms = [
      ...new Set([...Object.keys(((company.settings ?? {}) as { leadForms?: Record<string, unknown> }).leadForms ?? {}), ...((((conn.settings ?? {}) as { formIds?: string[] }).formIds) ?? [])]),
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
        const r = await this.d.adapters.metaLeads.listFormLeads(formId, since, after, token, opts.pageSize);
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
      await this.saveCursor(conn.id, companyId, stream, { since: maxSeen.toISOString(), after: null }, stat);
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
