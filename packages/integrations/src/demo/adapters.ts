import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { ProviderError } from '../http';
import type { MetaAdNames, MetaDirectClient, MetaLeadData, MetaLeadsClient } from '../meta/clients';

/**
 * DEMO adapters (TZ §25.1). They keep state in Redis so API and worker processes agree, never
 * contact a real provider, and are rejected at startup outside APP_MODE=demo. Failure injection
 * (`injectFailure`) exists for tests of retry, 429 and unknown-outcome reconciliation.
 */

export type DemoFailure = 'timeout_after_create' | 'timeout_before' | 'rate_limited' | 'server_error' | 'unauthorized' | 'validation';

export class DemoStore {
  constructor(
    readonly redis: Redis,
    readonly ns = 'demo',
  ) {}
  k(...parts: string[]) {
    return [this.ns, ...parts].join(':');
  }
  async injectFailure(target: string, failure: DemoFailure, times = 1) {
    for (let i = 0; i < times; i++) await this.redis.rpush(this.k('fail', target), failure);
  }
  async takeFailure(target: string): Promise<DemoFailure | null> {
    return (await this.redis.lpop(this.k('fail', target))) as DemoFailure | null;
  }
  async seq(name: string, start = 50_000_000): Promise<string> {
    const n = await this.redis.incr(this.k('seq', name));
    return String(start + n);
  }
  async reset() {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.ns}:*`, 'COUNT', 500);
      if (keys.length) await this.redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  }
}

function failureToError(f: DemoFailure, mutation: boolean): ProviderError {
  switch (f) {
    case 'rate_limited':
      return new ProviderError('HTTP 429 (demo)', 'rate_limited', 429, 1000);
    case 'server_error':
      return new ProviderError('HTTP 503 (demo)', 'transient', 503);
    case 'unauthorized':
      return new ProviderError('HTTP 401 (demo)', 'unauthorized', 401);
    case 'validation':
      return new ProviderError('HTTP 400 (demo)', 'validation', 400);
    case 'timeout_before':
    case 'timeout_after_create':
      return new ProviderError('Request outcome unknown: timeout (demo)', mutation ? 'unknown_outcome' : 'transient', null);
  }
}

export class DemoMetaLeadsClient implements MetaLeadsClient {
  readonly descriptor = { name: 'meta-leads-demo', kind: 'mock' as const };
  constructor(private readonly store: DemoStore) {}

  /** Demo-only: registers form answers that a later leadgen webhook will reference. */
  async registerLead(data: MetaLeadData) {
    await this.store.redis.set(this.store.k('meta', 'lead', data.leadgenId), JSON.stringify(data));
    if (data.formId) await this.store.redis.zadd(this.store.k('meta', 'form', data.formId), (data.createdTime ?? new Date()).getTime(), data.leadgenId);
  }

  /** Cursor = numeric offset; small default page size exercises pagination. */
  async listFormLeads(formId: string, since: Date, after: string | null, _token: string, limit = 2) {
    const f = await this.store.takeFailure('meta_leads');
    if (f) throw failureToError(f, false);
    const offset = after ? Number(after) : 0;
    const ids = await this.store.redis.zrangebyscore(this.store.k('meta', 'form', formId), `(${since.getTime()}`, '+inf', 'LIMIT', offset, limit + 1);
    const items = await Promise.all(ids.slice(0, limit).map((id) => this.fetchLead(id)));
    return { items, after: ids.length > limit ? String(offset + limit) : null };
  }

  async fetchLead(leadgenId: string): Promise<MetaLeadData> {
    const f = await this.store.takeFailure('meta_leads');
    if (f) throw failureToError(f, false);
    const raw = await this.store.redis.get(this.store.k('meta', 'lead', leadgenId));
    if (!raw) throw new ProviderError('HTTP 404 (demo): lead not found', 'validation', 404);
    const d = JSON.parse(raw) as MetaLeadData & { createdTime: string | null };
    return { ...d, createdTime: d.createdTime ? new Date(d.createdTime) : null };
  }

  async fetchAdNames(adId: string): Promise<MetaAdNames> {
    const f = await this.store.takeFailure('meta_adnames');
    if (f) throw failureToError(f, false);
    return { adName: `Demo ad ${adId}`, adsetName: 'Demo adset', campaignName: 'Demo kampaniya' };
  }
}

export class DemoMetaDirectClient implements MetaDirectClient {
  readonly descriptor = { name: 'meta-direct-demo', kind: 'mock' as const };
  constructor(private readonly store: DemoStore) {}
  async sendText(p: { businessAccountId: string; recipientScopedId: string; text: string; tag: 'HUMAN_AGENT' | null }) {
    const f = await this.store.takeFailure('meta_direct');
    const messageId = `demo_mid_${randomUUID()}`;
    if (f && f !== 'timeout_after_create') throw failureToError(f, true);
    await this.store.redis.rpush(this.store.k('meta', 'sent'), JSON.stringify({ ...p, messageId, at: new Date().toISOString() }));
    if (f === 'timeout_after_create') throw failureToError(f, true);
    return { messageId };
  }
  async sentMessages(): Promise<Array<{ recipientScopedId: string; text: string; messageId: string; tag: string | null }>> {
    return (await this.store.redis.lrange(this.store.k('meta', 'sent'), 0, -1)).map((s) => JSON.parse(s));
  }
}
