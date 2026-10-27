import { canonicalEventKey } from '@crm/domain';

/**
 * Splits one Meta webhook delivery into individual events, each with its own dedupe key
 * (TZ §16.2: "Bir webhook ichidagi har bir xabar yoki lead hodisasi alohida kalit oladi").
 *
 * Shapes follow Meta's documented webhook envelopes ([S08], [S09]); field presence is treated as
 * optional and must be confirmed with real responses in G04/G05/G09.
 */

export interface LeadgenEvent {
  kind: 'leadgen';
  key: string;
  pageId: string;
  leadgenId: string;
  formId: string | null;
  adId: string | null;
  adgroupId: string | null;
  createdTime: Date | null;
}

export interface IgMessageEvent {
  kind: 'ig_message';
  key: string;
  businessAccountId: string;
  scopedPeerId: string;
  mid: string;
  text: string | null;
  attachments: Array<{ type: string; url: string | null }>;
  isEcho: boolean;
  isUnsupported: boolean;
  timestamp: Date;
  referral: IgReferral | null;
}

/** Meta `referral` (click-to-Direct reklama va boshqa kirish nuqtalari). Vaqtinchalik media URL'lari saqlanmaydi. */
export type IgReferral = {
  source: string | null;
  type: string | null;
  adId: string | null;
  ref: string | null;
  adTitle?: string | null;
  postId?: string | null;
  productId?: string | null;
};

/** Xabarsiz alohida kelgan referral (masalan, mavjud suhbatda reklama orqali qayta ochilganda). */
export interface IgReferralEvent {
  kind: 'ig_referral';
  key: string;
  businessAccountId: string;
  scopedPeerId: string;
  timestamp: Date;
  referral: IgReferral;
}

/** Faqat rasmiy reklama dalili: source=ADS yoki ad_id. Boshqa referral (ig.me havola, mahsulot) reklama hisoblanmaydi. */
export function isAdReferral(r: IgReferral | null | undefined): r is IgReferral {
  return !!r && ((r.source ?? '').toUpperCase() === 'ADS' || !!r.adId);
}

export interface IgReadEvent {
  kind: 'ig_read';
  key: string;
  businessAccountId: string;
  scopedPeerId: string;
  mid: string | null;
  timestamp: Date;
}

export interface UnsupportedEvent {
  kind: 'unsupported';
  key: string;
  object: string;
  field: string;
}

export type MetaEvent = LeadgenEvent | IgMessageEvent | IgReadEvent | IgReferralEvent | UnsupportedEvent;

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);
const parseReferral = (raw: Json): IgReferral => {
  const ctx = (raw.ads_context_data ?? {}) as Json;
  return { source: str(raw.source), type: str(raw.type), adId: str(raw.ad_id), ref: str(raw.ref), adTitle: str(ctx.ad_title), postId: str(ctx.post_id), productId: str(ctx.product_id) };
};
const tsToDate = (v: unknown): Date | null => {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return new Date(n < 1e12 ? n * 1000 : n);
};

export function parseMetaWebhook(body: unknown): MetaEvent[] {
  const root = (body ?? {}) as Json;
  const object = str(root.object) ?? 'unknown';
  const entries = Array.isArray(root.entry) ? (root.entry as Json[]) : [];
  const events: MetaEvent[] = [];

  for (const entry of entries) {
    const entryId = str(entry.id) ?? '';
    for (const change of Array.isArray(entry.changes) ? (entry.changes as Json[]) : []) {
      const field = str(change.field) ?? 'unknown';
      const value = (change.value ?? {}) as Json;
      if (object === 'page' && field === 'leadgen' && str(value.leadgen_id)) {
        events.push({
          kind: 'leadgen',
          key: `leadgen:${str(value.leadgen_id)}`,
          pageId: str(value.page_id) ?? entryId,
          leadgenId: str(value.leadgen_id)!,
          formId: str(value.form_id),
          adId: str(value.ad_id),
          adgroupId: str(value.adgroup_id),
          createdTime: tsToDate(value.created_time),
        });
      } else {
        events.push({ kind: 'unsupported', key: canonicalEventKey('meta', { object, entryId, field, value: JSON.stringify(value) }), object, field });
      }
    }

    for (const m of Array.isArray(entry.messaging) ? (entry.messaging as Json[]) : []) {
      const sender = str((m.sender as Json | undefined)?.id);
      const recipient = str((m.recipient as Json | undefined)?.id);
      const timestamp = tsToDate(m.timestamp) ?? new Date(0);
      const message = m.message as Json | undefined;
      if (message && sender && recipient) {
        const isEcho = message.is_echo === true;
        const mid = str(message.mid);
        const attachments = (Array.isArray(message.attachments) ? (message.attachments as Json[]) : []).map((a) => ({
          type: str(a.type) ?? 'unknown',
          url: str((a.payload as Json | undefined)?.url),
        }));
        const referralRaw = (message.referral ?? m.referral) as Json | undefined;
        const businessAccountId = isEcho ? sender : recipient;
        const scopedPeerId = isEcho ? recipient : sender;
        const text = str(message.text);
        events.push({
          kind: 'ig_message',
          key: mid ? `ig_${isEcho ? 'echo' : 'msg'}:${mid}` : canonicalEventKey('meta_ig', { sender, recipient, ts: timestamp.getTime(), text, isEcho: isEcho ? 1 : 0 }),
          businessAccountId,
          scopedPeerId,
          mid: mid ?? '',
          text,
          attachments,
          isEcho,
          isUnsupported: message.is_unsupported === true || (!text && attachments.length === 0),
          timestamp,
          referral: referralRaw ? parseReferral(referralRaw) : null,
        });
        continue;
      }
      const referralOnly = m.referral as Json | undefined;
      if (referralOnly && sender && recipient) {
        const referral = parseReferral(referralOnly);
        events.push({
          kind: 'ig_referral',
          key: `ig_referral:${recipient}:${sender}:${timestamp.getTime()}:${referral.adId ?? referral.ref ?? ''}`,
          businessAccountId: recipient,
          scopedPeerId: sender,
          timestamp,
          referral,
        });
        continue;
      }
      const read = m.read as Json | undefined;
      if (read && sender && recipient) {
        const mid = str(read.mid);
        events.push({
          kind: 'ig_read',
          key: `ig_read:${recipient}:${sender}:${mid ?? timestamp.getTime()}`,
          businessAccountId: recipient,
          scopedPeerId: sender,
          mid,
          timestamp,
        });
        continue;
      }
      events.push({ kind: 'unsupported', key: canonicalEventKey('meta', { object, entryId, m: JSON.stringify(m) }), object, field: 'messaging' });
    }
  }
  return events;
}
