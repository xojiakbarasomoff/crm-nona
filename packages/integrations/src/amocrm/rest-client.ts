import { ProviderError, requestJson, type FetchLike } from '../http';
import type { RedisRateLimiter } from '../redis-primitives';
import {
  opMarker,
  type AmoContactSnapshot,
  type AmoLeadSnapshot,
  type AmoPipeline,
  type AmoRestClient,
  type AmoUser,
  type CreateLeadInput,
  type CreateTaskInput,
} from './types';

/**
 * Live amoCRM REST API v4 client ([S01], [S04], [S05]). Not yet verified against a real account
 * (G01, G02 blocked). Every request passes the shared Redis limiter (default 5 rps per integration).
 */

export interface AmoTokenProvider {
  /** Returns a currently valid access token. */
  getAccessToken(): Promise<string>;
  /** Performs one synchronized refresh (per-connection lock) and returns the new token. */
  refresh(): Promise<string>;
}

type Json = Record<string, unknown>;

export class LiveAmoRestClient implements AmoRestClient {
  readonly descriptor = { name: 'amocrm-rest-v4', kind: 'live' as const };

  constructor(
    private readonly domain: string,
    private readonly tokens: AmoTokenProvider,
    private readonly limiter: RedisRateLimiter,
    private readonly limiterKey: string,
    private readonly rps: number,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call<T>(path: string, init: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; mutation?: boolean } = {}): Promise<T> {
    const send = async (token: string) => {
      await this.limiter.acquire(this.limiterKey, this.rps);
      return requestJson<T>(
        `https://${this.domain}${path}`,
        {
          method: init.method ?? 'GET',
          mutation: init.mutation,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        },
        this.fetchImpl,
      );
    };
    try {
      return await send(await this.tokens.getAccessToken());
    } catch (err) {
      if (err instanceof ProviderError && err.errorClass === 'unauthorized') return send(await this.tokens.refresh());
      throw err;
    }
  }

  async getAccount() {
    const r = await this.call<Json>('/api/v4/account');
    return { id: String(r.id), subdomain: String(r.subdomain) };
  }

  async listUsers(): Promise<AmoUser[]> {
    const r = await this.call<Json>('/api/v4/users?limit=250');
    const users = ((r?._embedded as Json | undefined)?.users ?? []) as Json[];
    return users.map((u) => ({ id: String(u.id), name: String(u.name ?? ''), email: typeof u.email === 'string' ? u.email : null }));
  }

  async listPipelines(): Promise<AmoPipeline[]> {
    const r = await this.call<Json>('/api/v4/leads/pipelines');
    const pipelines = ((r?._embedded as Json | undefined)?.pipelines ?? []) as Json[];
    return pipelines.map((p) => ({
      id: String(p.id),
      name: String(p.name),
      isMain: p.is_main === true,
      statuses: (((p._embedded as Json | undefined)?.statuses ?? []) as Json[]).map((s) => ({
        id: String(s.id),
        name: String(s.name),
        // 142 = won, 143 = lost are the documented system status ids ([S05]).
        type: s.id === 142 ? ('won' as const) : s.id === 143 ? ('lost' as const) : ('normal' as const),
      })),
    }));
  }

  async getLead(id: string): Promise<AmoLeadSnapshot | null> {
    try {
      const r = await this.call<Json>(`/api/v4/leads/${encodeURIComponent(id)}?with=contacts`);
      return r ? toLead(r) : null;
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return null;
      throw err;
    }
  }

  async getContact(id: string): Promise<AmoContactSnapshot | null> {
    try {
      const r = await this.call<Json>(`/api/v4/contacts/${encodeURIComponent(id)}`);
      return r ? toContact(r) : null;
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return null;
      throw err;
    }
  }

  async listLeadsUpdatedSince(since: Date, page: number, limit: number) {
    const q = `filter[updated_at][from]=${Math.floor(since.getTime() / 1000)}&order[updated_at]=asc&with=contacts&page=${page}&limit=${limit}`;
    const r = await this.call<Json | undefined>(`/api/v4/leads?${q}`);
    const items = (((r?._embedded as Json | undefined)?.leads ?? []) as Json[]).map(toLead);
    return { items, hasMore: !!(r?._links as Json | undefined)?.next };
  }

  async listContactsUpdatedSince(since: Date, page: number, limit: number) {
    const q = `filter[updated_at][from]=${Math.floor(since.getTime() / 1000)}&order[updated_at]=asc&page=${page}&limit=${limit}`;
    const r = await this.call<Json | undefined>(`/api/v4/contacts?${q}`);
    const items = (((r?._embedded as Json | undefined)?.contacts ?? []) as Json[]).map(toContact);
    return { items, hasMore: !!(r?._links as Json | undefined)?.next };
  }

  async createLeadWithContact(input: CreateLeadInput) {
    const cf = [...input.customFields];
    if (input.operationFieldId) cf.push({ fieldId: input.operationFieldId, value: input.operationId });
    const contact: Json = input.contact.existingId
      ? { id: Number(input.contact.existingId) }
      : {
          name: input.contact.name ?? undefined,
          custom_fields_values: [
            ...(input.contact.phone ? [{ field_code: 'PHONE', values: [{ value: input.contact.phone, enum_code: 'WORK' }] }] : []),
            ...(input.contact.email ? [{ field_code: 'EMAIL', values: [{ value: input.contact.email, enum_code: 'WORK' }] }] : []),
          ],
        };
    const body = [
      {
        name: input.name,
        pipeline_id: Number(input.pipelineId),
        status_id: Number(input.statusId),
        ...(input.responsibleUserId ? { responsible_user_id: Number(input.responsibleUserId) } : {}),
        custom_fields_values: cf.map((f) => ({ field_id: Number(f.fieldId), values: [{ value: f.value }] })),
        _embedded: { contacts: [contact] },
      },
    ];
    const r = await this.call<Json[]>('/api/v4/leads/complex', { method: 'POST', body, mutation: true });
    const first = Array.isArray(r) ? r[0] : undefined;
    if (!first?.id) throw new ProviderError('Complex create returned no id', 'unknown_outcome', null);
    return { leadId: String(first.id), contactId: String(first.contact_id ?? input.contact.existingId ?? '') };
  }

  async findLeadByOperationId(operationId: string) {
    const r = await this.call<Json | undefined>(`/api/v4/leads?query=${encodeURIComponent(operationId)}&with=contacts&limit=5`);
    const leads = (((r?._embedded as Json | undefined)?.leads ?? []) as Json[]).map(toLead);
    const match = leads.find((l) => Object.values(l.customFields).includes(operationId));
    return match ? { leadId: match.id, contactId: match.contactIds[0] ?? null } : null;
  }

  async updateLead(id: string, patch: { statusId?: string; pipelineId?: string; responsibleUserId?: string; price?: number; customFields?: Array<{ fieldId: string; value: string }> }) {
    const body: Json = {};
    if (patch.statusId) body.status_id = Number(patch.statusId);
    if (patch.pipelineId) body.pipeline_id = Number(patch.pipelineId);
    if (patch.responsibleUserId) body.responsible_user_id = Number(patch.responsibleUserId);
    if (patch.price !== undefined) body.price = patch.price;
    if (patch.customFields) body.custom_fields_values = patch.customFields.map((f) => ({ field_id: Number(f.fieldId), values: [{ value: f.value }] }));
    const r = await this.call<Json>(`/api/v4/leads/${encodeURIComponent(id)}`, { method: 'PATCH', body, mutation: true });
    return { updatedAt: new Date(Number(r?.updated_at ?? Date.now() / 1000) * 1000) };
  }

  async createTask(input: CreateTaskInput) {
    const body = [
      {
        entity_type: input.entityType,
        entity_id: Number(input.entityId),
        text: `${input.text} ${opMarker(input.operationKey)}`,
        complete_till: Math.floor(input.completeTill.getTime() / 1000),
        ...(input.responsibleUserId ? { responsible_user_id: Number(input.responsibleUserId) } : {}),
      },
    ];
    const r = await this.call<Json>('/api/v4/tasks', { method: 'POST', body, mutation: true });
    const task = (((r?._embedded as Json | undefined)?.tasks ?? []) as Json[])[0];
    if (!task?.id) throw new ProviderError('Task create returned no id', 'unknown_outcome', null);
    return { taskId: String(task.id) };
  }

  async findTaskByOperationKey(entityType: 'leads' | 'contacts', entityId: string, operationKey: string) {
    const r = await this.call<Json | undefined>(`/api/v4/tasks?filter[entity_type]=${entityType}&filter[entity_id][]=${encodeURIComponent(entityId)}&limit=250`);
    const tasks = ((r?._embedded as Json | undefined)?.tasks ?? []) as Json[];
    const t = tasks.find((x) => typeof x.text === 'string' && x.text.includes(opMarker(operationKey)));
    return t ? { taskId: String(t.id) } : null;
  }

  async completeTask(taskId: string, resultText: string) {
    await this.call(`/api/v4/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: { is_completed: true, result: { text: resultText } }, mutation: true });
  }

  async updateTaskResponsible(taskId: string, responsibleUserId: string) {
    await this.call(`/api/v4/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: { responsible_user_id: Number(responsibleUserId) }, mutation: true });
  }

  async addNote(entityType: 'leads' | 'contacts', entityId: string, text: string) {
    await this.call(`/api/v4/${entityType}/${encodeURIComponent(entityId)}/notes`, { method: 'POST', body: [{ note_type: 'common', params: { text } }], mutation: true });
  }

  async listCustomFields(entity: 'leads' | 'contacts') {
    const r = await this.call<Json | undefined>(`/api/v4/${entity}/custom_fields?limit=250`);
    return (((r?._embedded as Json | undefined)?.custom_fields ?? []) as Json[]).map((f) => ({
      id: String(f.id),
      name: String(f.name),
      code: typeof f.code === 'string' ? f.code : null,
      type: String(f.type),
    }));
  }

  async createCustomField(entity: 'leads' | 'contacts', field: { name: string; type: string; code: string }) {
    const r = await this.call<Json>(`/api/v4/${entity}/custom_fields`, { method: 'POST', body: [field], mutation: true });
    const f = (((r?._embedded as Json | undefined)?.custom_fields ?? []) as Json[])[0];
    if (!f?.id) throw new ProviderError('Custom field create returned no id', 'unknown_outcome', null);
    return { id: String(f.id) };
  }
}

function customFieldMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of Array.isArray(raw) ? (raw as Json[]) : []) {
    const values = Array.isArray(f.values) ? (f.values as Json[]) : [];
    const v = values.map((x) => String(x.value ?? '')).filter(Boolean).join(', ');
    if (f.field_id !== undefined) out[String(f.field_id)] = v;
    if (typeof f.field_code === 'string') out[f.field_code] = v;
  }
  return out;
}

export function toLead(r: Json): AmoLeadSnapshot {
  const contacts = (((r._embedded as Json | undefined)?.contacts ?? []) as Json[]).map((c) => String(c.id));
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    pipelineId: String(r.pipeline_id),
    statusId: String(r.status_id),
    responsibleUserId: r.responsible_user_id ? String(r.responsible_user_id) : null,
    price: typeof r.price === 'number' ? r.price : null,
    updatedAt: new Date(Number(r.updated_at) * 1000),
    closedAt: r.closed_at ? new Date(Number(r.closed_at) * 1000) : null,
    contactIds: contacts,
    customFields: customFieldMap(r.custom_fields_values),
    deleted: r.is_deleted === true,
  };
}

export function toContact(r: Json): AmoContactSnapshot {
  const cf = Array.isArray(r.custom_fields_values) ? (r.custom_fields_values as Json[]) : [];
  const values = (code: string) =>
    cf.filter((f) => f.field_code === code).flatMap((f) => (Array.isArray(f.values) ? (f.values as Json[]) : []).map((v) => String(v.value)));
  return {
    id: String(r.id),
    name: typeof r.name === 'string' ? r.name : null,
    phones: values('PHONE'),
    emails: values('EMAIL'),
    responsibleUserId: r.responsible_user_id ? String(r.responsible_user_id) : null,
    updatedAt: new Date(Number(r.updated_at) * 1000),
    customFields: customFieldMap(r.custom_fields_values),
    deleted: r.is_deleted === true,
  };
}
