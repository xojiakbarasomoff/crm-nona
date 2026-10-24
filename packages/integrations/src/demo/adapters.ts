import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { ProviderError } from '../http';
import type { AmoChatsClient, ChatsInboundMessage } from '../amocrm/chats';
import {
  opMarker,
  type AmoContactSnapshot,
  type AmoLeadSnapshot,
  type AmoPipeline,
  type AmoRestClient,
  type AmoUser,
  type CreateLeadInput,
  type CreateTaskInput,
} from '../amocrm/types';
import type { MetaAdNames, MetaDirectClient, MetaLeadData, MetaLeadsClient } from '../meta/clients';

/**
 * DEMO adapters (TZ §25.1). They keep state in Redis so API and worker processes agree, never
 * contact a real provider, and are rejected at startup outside APP_MODE=demo. Failure injection
 * (`injectFailure`) exists for tests of retry, 429 and unknown-outcome reconciliation.
 */

export type DemoFailure = 'timeout_after_create' | 'timeout_before' | 'rate_limited' | 'server_error' | 'unauthorized' | 'validation';

export const DEMO_PIPELINE_ID = '7000001';
export const DEMO_STATUS_IDS: Record<string, string> = {
  NEW: '7100001',
  CONTACTED: '7100002',
  QUALIFIED: '7100003',
  PREPARING_OFFER: '7100004',
  OFFER_SENT: '7100005',
  AWAITING_PAYMENT: '7100006',
  FOLLOW_UP: '7100009',
  WON: '142',
  LOST: '143',
};

/** Demo amoCRM users; the seed links local users to these ids. */
export const DEMO_AMO_USERS: AmoUser[] = [
  { id: '9000001', name: 'Admin (demo)', email: 'admin@demo.local' },
  { id: '9000002', name: 'Rahbar (demo)', email: 'rahbar@demo.local' },
  { id: '9000003', name: 'Menejer A (demo)', email: 'menejer.a@demo.local' },
  { id: '9000004', name: 'Menejer B (demo)', email: 'menejer.b@demo.local' },
  { id: '9000005', name: 'Menejer C (demo)', email: 'menejer.c@demo.local' },
];

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

interface StoredLead extends Omit<AmoLeadSnapshot, 'updatedAt' | 'closedAt'> {
  updatedAt: string;
  closedAt: string | null;
}

export class DemoAmoRestClient implements AmoRestClient {
  readonly descriptor = { name: 'amocrm-demo', kind: 'mock' as const };
  constructor(
    private readonly store: DemoStore,
    private readonly users: AmoUser[] = DEMO_AMO_USERS,
  ) {}

  private async maybeFail(mutation: boolean): Promise<DemoFailure | null> {
    const f = await this.store.takeFailure('amo');
    if (!f) return null;
    if (f === 'timeout_after_create') return f;
    throw failureToError(f, mutation);
  }

  async getAccount() {
    return { id: '30000001', subdomain: 'demo-turizm' };
  }
  async listUsers() {
    return this.users;
  }
  async listPipelines(): Promise<AmoPipeline[]> {
    return [
      {
        id: DEMO_PIPELINE_ID,
        name: 'Turizm (demo)',
        isMain: true,
        statuses: Object.entries(DEMO_STATUS_IDS).map(([code, id]) => ({ id, name: code, type: id === '142' ? 'won' : id === '143' ? 'lost' : 'normal' })),
      },
    ];
  }

  private async readLead(id: string): Promise<AmoLeadSnapshot | null> {
    const raw = await this.store.redis.get(this.store.k('amo', 'lead', id));
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredLead;
    return { ...s, updatedAt: new Date(s.updatedAt), closedAt: s.closedAt ? new Date(s.closedAt) : null };
  }
  private async writeLead(l: AmoLeadSnapshot) {
    const s: StoredLead = { ...l, updatedAt: l.updatedAt.toISOString(), closedAt: l.closedAt?.toISOString() ?? null };
    await this.store.redis.set(this.store.k('amo', 'lead', l.id), JSON.stringify(s));
    await this.store.redis.zadd(this.store.k('amo', 'leads_by_updated'), l.updatedAt.getTime(), l.id);
  }

  async getLead(id: string) {
    await this.maybeFail(false);
    return this.readLead(id);
  }

  async getContact(id: string): Promise<AmoContactSnapshot | null> {
    await this.maybeFail(false);
    const raw = await this.store.redis.get(this.store.k('amo', 'contact', id));
    if (!raw) return null;
    const c = JSON.parse(raw) as AmoContactSnapshot & { updatedAt: string };
    return { ...c, updatedAt: new Date(c.updatedAt) };
  }

  async listLeadsUpdatedSince(since: Date, page: number, limit: number) {
    const ids = await this.store.redis.zrangebyscore(this.store.k('amo', 'leads_by_updated'), since.getTime(), '+inf', 'LIMIT', (page - 1) * limit, limit + 1);
    const items = (await Promise.all(ids.slice(0, limit).map((id) => this.readLead(id)))).filter((x): x is AmoLeadSnapshot => !!x);
    return { items, hasMore: ids.length > limit };
  }

  async listContactsUpdatedSince() {
    return { items: [], hasMore: false };
  }

  async createLeadWithContact(input: CreateLeadInput) {
    const f = await this.maybeFail(true);
    const existing = await this.store.redis.get(this.store.k('amo', 'op', input.operationId));
    if (existing) {
      // A real API would create a duplicate here; the demo mirrors that so reconciliation is tested honestly.
    }
    const leadId = await this.store.seq('lead');
    const contactId = input.contact.existingId ?? (await this.store.seq('contact'));
    if (!input.contact.existingId) {
      const contact = {
        id: contactId,
        name: input.contact.name,
        phones: input.contact.phone ? [input.contact.phone] : [],
        emails: input.contact.email ? [input.contact.email] : [],
        responsibleUserId: input.responsibleUserId,
        updatedAt: new Date().toISOString(),
        customFields: {},
        deleted: false,
      };
      await this.store.redis.set(this.store.k('amo', 'contact', contactId), JSON.stringify(contact));
    }
    const customFields: Record<string, string> = { operation_id: input.operationId };
    for (const c of input.customFields) customFields[c.fieldId] = c.value;
    await this.writeLead({
      id: leadId,
      name: input.name,
      pipelineId: input.pipelineId,
      statusId: input.statusId,
      responsibleUserId: input.responsibleUserId,
      price: null,
      updatedAt: new Date(),
      closedAt: null,
      contactIds: [contactId],
      customFields,
      deleted: false,
    });
    await this.store.redis.set(this.store.k('amo', 'op', input.operationId), JSON.stringify({ leadId, contactId }));
    await this.store.redis.incr(this.store.k('amo', 'creates'));
    if (f === 'timeout_after_create') throw failureToError(f, true);
    return { leadId, contactId };
  }

  async findLeadByOperationId(operationId: string) {
    await this.maybeFail(false);
    const raw = await this.store.redis.get(this.store.k('amo', 'op', operationId));
    return raw ? (JSON.parse(raw) as { leadId: string; contactId: string }) : null;
  }

  async updateLead(id: string, patch: { statusId?: string; pipelineId?: string; responsibleUserId?: string; price?: number; customFields?: Array<{ fieldId: string; value: string }> }) {
    const f = await this.maybeFail(true);
    const lead = await this.readLead(id);
    if (!lead) throw new ProviderError('HTTP 404 (demo)', 'validation', 404);
    const updatedAt = new Date(Math.max(Date.now(), lead.updatedAt.getTime() + 1000));
    const next: AmoLeadSnapshot = {
      ...lead,
      statusId: patch.statusId ?? lead.statusId,
      pipelineId: patch.pipelineId ?? lead.pipelineId,
      responsibleUserId: patch.responsibleUserId ?? lead.responsibleUserId,
      price: patch.price ?? lead.price,
      updatedAt,
      closedAt: patch.statusId === '142' || patch.statusId === '143' ? updatedAt : lead.closedAt,
      customFields: { ...lead.customFields, ...Object.fromEntries((patch.customFields ?? []).map((c) => [c.fieldId, c.value])) },
    };
    await this.writeLead(next);
    if (f === 'timeout_after_create') throw failureToError(f, true);
    return { updatedAt };
  }

  /** Demo-only: simulates a manual edit made natively inside amoCRM. */
  async simulateNativeEdit(id: string, patch: { statusId?: string; responsibleUserId?: string; deleted?: boolean }, at = new Date()) {
    const lead = await this.readLead(id);
    if (!lead) throw new Error('demo lead not found');
    await this.writeLead({
      ...lead,
      statusId: patch.statusId ?? lead.statusId,
      responsibleUserId: patch.responsibleUserId ?? lead.responsibleUserId,
      deleted: patch.deleted ?? lead.deleted,
      updatedAt: at,
    });
  }

  async createTask(input: CreateTaskInput) {
    const f = await this.maybeFail(true);
    const taskId = await this.store.seq('task');
    const task = { id: taskId, ...input, text: `${input.text} ${opMarker(input.operationKey)}`, completed: false, completeTill: input.completeTill.toISOString() };
    await this.store.redis.set(this.store.k('amo', 'task', taskId), JSON.stringify(task));
    await this.store.redis.set(this.store.k('amo', 'taskop', input.operationKey), taskId);
    await this.store.redis.incr(this.store.k('amo', 'task_creates'));
    if (f === 'timeout_after_create') throw failureToError(f, true);
    return { taskId };
  }

  async findTaskByOperationKey(_e: 'leads' | 'contacts', _id: string, operationKey: string) {
    const taskId = await this.store.redis.get(this.store.k('amo', 'taskop', operationKey));
    return taskId ? { taskId } : null;
  }

  async completeTask(taskId: string, resultText: string) {
    await this.maybeFail(true);
    const raw = await this.store.redis.get(this.store.k('amo', 'task', taskId));
    if (!raw) return;
    await this.store.redis.set(this.store.k('amo', 'task', taskId), JSON.stringify({ ...JSON.parse(raw), completed: true, result: resultText }));
  }

  async updateTaskResponsible(taskId: string, responsibleUserId: string) {
    await this.maybeFail(true);
    const raw = await this.store.redis.get(this.store.k('amo', 'task', taskId));
    if (!raw) return;
    await this.store.redis.set(this.store.k('amo', 'task', taskId), JSON.stringify({ ...JSON.parse(raw), responsibleUserId }));
  }

  async addNote(entityType: string, entityId: string, text: string) {
    await this.maybeFail(true);
    await this.store.redis.rpush(this.store.k('amo', 'notes', entityType, entityId), text);
  }

  async createPipelineStatus(_pipelineId: string, _name: string) {
    return { id: await this.store.seq('status', 7_200_000) };
  }

  async listCustomFields(entity: 'leads' | 'contacts') {
    const raw = await this.store.redis.hgetall(this.store.k('amo', 'fields', entity));
    return Object.entries(raw).map(([code, json]) => ({ ...(JSON.parse(json) as { id: string; name: string; type: string }), code }));
  }

  async createCustomField(entity: 'leads' | 'contacts', field: { name: string; type: string; code: string }) {
    const id = await this.store.seq('field', 900_000);
    await this.store.redis.hset(this.store.k('amo', 'fields', entity), field.code, JSON.stringify({ id, name: field.name, type: field.type }));
    return { id };
  }
}

export class DemoMetaLeadsClient implements MetaLeadsClient {
  readonly descriptor = { name: 'meta-leads-demo', kind: 'mock' as const };
  constructor(private readonly store: DemoStore) {}

  /** Demo-only: registers form answers that a later leadgen webhook will reference. */
  async registerLead(data: MetaLeadData) {
    await this.store.redis.set(this.store.k('meta', 'lead', data.leadgenId), JSON.stringify(data));
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

export class DemoAmoChatsClient implements AmoChatsClient {
  readonly descriptor = { name: 'amocrm-chats-demo', kind: 'mock' as const };
  constructor(private readonly store: DemoStore) {}
  async connectAccount(amojoAccountId: string) {
    return { scopeId: `demo_scope_${amojoAccountId}` };
  }
  async importInbound(scopeId: string, msg: ChatsInboundMessage) {
    const f = await this.store.takeFailure('amo_chats');
    if (f) throw failureToError(f, true);
    const amoMessageId = `demo_amo_msg_${await this.store.seq('chatmsg')}`;
    await this.store.redis.rpush(this.store.k('chats', 'imported'), JSON.stringify({ ...msg, scopeId, amoMessageId }));
    return { amoMessageId };
  }
  async setDeliveryStatus(scopeId: string, amoMessageId: string, status: string, error?: string) {
    await this.store.redis.rpush(this.store.k('chats', 'status'), JSON.stringify({ scopeId, amoMessageId, status, error }));
  }
}
