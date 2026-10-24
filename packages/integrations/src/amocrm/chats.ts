import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { requestJson, type FetchLike } from '../http';

/**
 * amoCRM Chats API (amojo) custom channel ([S03]). Authentication is separate from REST OAuth:
 * requests are signed with the channel secret obtained when the channel is registered with amoCRM.
 *
 * Signature scheme as implemented here (to be confirmed in G08 against the official docs and a
 * live channel): outgoing requests carry Date, Content-Type, Content-MD5 (hex md5 of body) and
 * X-Signature = hex(HMAC-SHA1(secret, METHOD\nContent-MD5\nContent-Type\nDate\nPath)). Incoming
 * webhooks carry X-Signature = hex(HMAC-SHA1(secret, rawBody)). It is deliberately NOT the Meta
 * scheme.
 */

export interface ChatsConfig {
  channelId: string;
  secret: string;
  baseUrl?: string;
}

export function signChatsRequest(secret: string, method: string, path: string, body: string, date: string, contentType = 'application/json') {
  const md5 = createHash('md5').update(body).digest('hex');
  const toSign = [method.toUpperCase(), md5, contentType, date, path].join('\n');
  const signature = createHmac('sha1', secret).update(toSign).digest('hex');
  return { 'Content-MD5': md5, 'Content-Type': contentType, Date: date, 'X-Signature': signature };
}

export function verifyChatsWebhook(rawBody: Buffer, header: string | undefined | null, secret: string): boolean {
  if (!header || !secret || !/^[0-9a-f]{40}$/i.test(header)) return false;
  const expected = createHmac('sha1', secret).update(rawBody).digest();
  const given = Buffer.from(header, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface ChatsInboundMessage {
  scopeId: string;
  conversationId: string;
  msgId: string;
  senderId: string;
  senderName: string | null;
  text: string | null;
  attachments: Array<{ type: string; url: string | null; name?: string | null }>;
  timestamp: Date;
}

export interface ChatsOutgoingReply {
  scopeId: string;
  /** amoCRM message id of the manager's reply */
  amoMessageId: string;
  /** Our conversation id (we pass it as conversation_id when importing). */
  conversationId: string;
  receiverId: string;
  text: string | null;
  authorAmoUserId: string | null;
  timestamp: Date;
}

export interface AmoChatsClient {
  readonly descriptor: { name: string; kind: 'mock' | 'live' };
  connectAccount(amojoAccountId: string, title: string): Promise<{ scopeId: string }>;
  /** Imports an inbound customer message into the amoCRM chat (creates the chat on first message). */
  importInbound(scopeId: string, msg: ChatsInboundMessage): Promise<{ amoMessageId: string | null }>;
  /** Reports delivery status of a manager message back to amoCRM. */
  setDeliveryStatus(scopeId: string, amoMessageId: string, status: 'delivered' | 'read' | 'failed', error?: string): Promise<void>;
}

type Json = Record<string, unknown>;

export class LiveAmoChatsClient implements AmoChatsClient {
  readonly descriptor = { name: 'amocrm-chats', kind: 'live' as const };
  private readonly base: string;
  constructor(
    private readonly cfg: ChatsConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (!cfg.channelId || !cfg.secret) throw new Error('AMO_CHAT_CHANNEL_ID and AMO_CHAT_SECRET are required for the Chats API');
    this.base = cfg.baseUrl ?? 'https://amojo.amocrm.ru';
  }

  private async post<T>(path: string, payload: unknown, mutation = true): Promise<T> {
    const body = JSON.stringify(payload);
    const headers = signChatsRequest(this.cfg.secret, 'POST', path, body, new Date().toUTCString());
    return requestJson<T>(`${this.base}${path}`, { method: 'POST', body, headers, mutation }, this.fetchImpl);
  }

  async connectAccount(amojoAccountId: string, title: string) {
    const r = await this.post<Json>(`/v2/origin/custom/${this.cfg.channelId}/connect`, { account_id: amojoAccountId, title, hook_api_version: 'v2' });
    if (typeof r?.scope_id !== 'string') throw new Error('Chats connect returned no scope_id');
    return { scopeId: r.scope_id };
  }

  async importInbound(scopeId: string, msg: ChatsInboundMessage) {
    const att = msg.attachments[0];
    const payload = {
      event_type: 'new_message',
      payload: {
        timestamp: Math.floor(msg.timestamp.getTime() / 1000),
        msec_timestamp: msg.timestamp.getTime(),
        msgid: msg.msgId,
        conversation_id: msg.conversationId,
        sender: { id: msg.senderId, name: msg.senderName ?? msg.senderId },
        message: att && !msg.text
          ? { type: att.type === 'image' ? 'picture' : 'file', media: att.url ?? undefined, file_name: att.name ?? undefined }
          : { type: 'text', text: msg.text ?? 'Ushbu xabar turini Instagram’da oching' },
        silent: false,
      },
    };
    const r = await this.post<Json>(`/v2/origin/custom/${scopeId}`, payload);
    const newMessage = (r?.new_message as Json | undefined) ?? {};
    return { amoMessageId: typeof newMessage.msgid === 'string' ? newMessage.msgid : null };
  }

  async setDeliveryStatus(scopeId: string, amoMessageId: string, status: 'delivered' | 'read' | 'failed', error?: string) {
    const code = status === 'delivered' ? 1 : status === 'read' ? 2 : -1;
    await this.post(`/v2/origin/custom/${scopeId}/${encodeURIComponent(amoMessageId)}/delivery_status`, {
      msgid: amoMessageId,
      delivery_status: code,
      ...(error ? { error_code: 905, error } : {}),
    });
  }
}

/** Parses an amojo outgoing-message webhook (manager reply typed in amoCRM). */
export function parseChatsWebhook(body: unknown): ChatsOutgoingReply | null {
  const root = (body ?? {}) as Json;
  const message = root.message as Json | undefined;
  if (!message) return null;
  const conversation = message.conversation as Json | undefined;
  const receiver = message.receiver as Json | undefined;
  const sender = message.sender as Json | undefined;
  const inner = message.message as Json | undefined;
  const scopeId = typeof root.account_id === 'string' ? root.account_id : typeof root.scope_id === 'string' ? root.scope_id : '';
  const amoMessageId = typeof inner?.id === 'string' ? inner.id : null;
  const conversationId = typeof conversation?.client_id === 'string' ? conversation.client_id : null;
  const receiverId = typeof receiver?.client_id === 'string' ? receiver.client_id : null;
  if (!amoMessageId || !conversationId || !receiverId) return null;
  return {
    scopeId,
    amoMessageId,
    conversationId,
    receiverId,
    text: typeof inner?.text === 'string' ? inner.text : null,
    authorAmoUserId: typeof sender?.id === 'string' ? sender.id : null,
    timestamp: new Date(Number(message.timestamp ?? root.time ?? Date.now() / 1000) * 1000),
  };
}
