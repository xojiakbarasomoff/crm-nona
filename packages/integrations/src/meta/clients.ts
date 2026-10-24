import { requestJson, type FetchLike } from '../http';

/**
 * Meta Graph API clients. Lead Ads and Direct are separate adapters with separate credentials
 * (TZ §3.2, [S06], [S09]). The Graph API version comes from configuration (META_GRAPH_VERSION) and
 * must be confirmed in G07. None of these calls has been verified against a live account yet.
 */

export interface MetaLeadData {
  leadgenId: string;
  createdTime: Date | null;
  formId: string | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  /** Only set when the API returns an explicit platform value; never guessed (TZ §8.1). */
  platform: string | null;
  fields: Record<string, string>;
}

export interface MetaAdNames {
  adName: string | null;
  adsetName: string | null;
  campaignName: string | null;
}

export interface MetaLeadsClient {
  readonly descriptor: { name: string; kind: 'mock' | 'live' };
  fetchLead(leadgenId: string, accessToken: string): Promise<MetaLeadData>;
  fetchAdNames(adId: string, accessToken: string): Promise<MetaAdNames>;
}

export interface MetaSendResult {
  messageId: string;
}

export interface MetaDirectClient {
  readonly descriptor: { name: string; kind: 'mock' | 'live' };
  sendText(params: { businessAccountId: string; recipientScopedId: string; text: string; tag: 'HUMAN_AGENT' | null; accessToken: string }): Promise<MetaSendResult>;
}

type Json = Record<string, unknown>;

export class GraphMetaLeadsClient implements MetaLeadsClient {
  readonly descriptor = { name: 'meta-leads-graph', kind: 'live' as const };
  constructor(
    private readonly version: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {
    if (!version) throw new Error('META_GRAPH_VERSION is required for the live Lead Ads client');
  }

  async fetchLead(leadgenId: string, accessToken: string): Promise<MetaLeadData> {
    const fields = 'created_time,field_data,form_id,ad_id,adset_id,campaign_id,platform';
    const url = `${this.baseUrl}/${this.version}/${encodeURIComponent(leadgenId)}?fields=${fields}`;
    const raw = await requestJson<Json>(url, { headers: { Authorization: `Bearer ${accessToken}` } }, this.fetchImpl);
    return normalizeLead(leadgenId, raw);
  }

  async fetchAdNames(adId: string, accessToken: string): Promise<MetaAdNames> {
    const url = `${this.baseUrl}/${this.version}/${encodeURIComponent(adId)}?fields=name,adset{name},campaign{name}`;
    const raw = await requestJson<Json>(url, { headers: { Authorization: `Bearer ${accessToken}` } }, this.fetchImpl);
    return {
      adName: typeof raw.name === 'string' ? raw.name : null,
      adsetName: typeof (raw.adset as Json | undefined)?.name === 'string' ? ((raw.adset as Json).name as string) : null,
      campaignName: typeof (raw.campaign as Json | undefined)?.name === 'string' ? ((raw.campaign as Json).name as string) : null,
    };
  }
}

export function normalizeLead(leadgenId: string, raw: Json): MetaLeadData {
  const fields: Record<string, string> = {};
  for (const f of Array.isArray(raw.field_data) ? (raw.field_data as Json[]) : []) {
    const name = typeof f.name === 'string' ? f.name : null;
    const values = Array.isArray(f.values) ? (f.values as unknown[]).filter((v): v is string => typeof v === 'string') : [];
    if (name && values.length) fields[name] = values.join(', ');
  }
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    leadgenId,
    createdTime: s(raw.created_time) ? new Date(s(raw.created_time)!) : null,
    formId: s(raw.form_id),
    adId: s(raw.ad_id),
    adsetId: s(raw.adset_id),
    campaignId: s(raw.campaign_id),
    platform: s(raw.platform),
    fields,
  };
}

export class GraphMetaDirectClient implements MetaDirectClient {
  readonly descriptor = { name: 'meta-direct-graph', kind: 'live' as const };
  constructor(
    private readonly version: string,
    private readonly login: 'instagram_login' | 'facebook_login',
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (!version) throw new Error('META_GRAPH_VERSION is required for the live Direct client');
  }

  async sendText(p: { businessAccountId: string; recipientScopedId: string; text: string; tag: 'HUMAN_AGENT' | null; accessToken: string }): Promise<MetaSendResult> {
    const host = this.login === 'instagram_login' ? 'https://graph.instagram.com' : 'https://graph.facebook.com';
    const path = this.login === 'instagram_login' ? 'me/messages' : `${encodeURIComponent(p.businessAccountId)}/messages`;
    const body: Json = { recipient: { id: p.recipientScopedId }, message: { text: p.text } };
    if (p.tag) Object.assign(body, { messaging_type: 'MESSAGE_TAG', tag: p.tag });
    const res = await requestJson<Json>(
      `${host}/${this.version}/${path}`,
      {
        method: 'POST',
        mutation: true,
        headers: { Authorization: `Bearer ${p.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      this.fetchImpl,
    );
    const messageId = typeof res?.message_id === 'string' ? res.message_id : null;
    if (!messageId) throw new Error('Send API did not return message_id');
    return { messageId };
  }
}
