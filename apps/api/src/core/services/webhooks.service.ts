import { randomUUID } from 'node:crypto';
import { parseAmoCrmWebhook, parseChatsWebhook, parseMetaWebhook, verifyChallenge, verifyChatsWebhook, verifyMetaSignature } from '@crm/integrations';
import type { CoreDeps } from '../context';
import { AppError } from '../errors';
import { storeInboxEvent } from '../queue';

/**
 * Webhook intake (TZ §19.1): validate → commit to inbox → ACK. No provider API calls happen here.
 * If the insert fails the exception propagates and the controller answers 5xx so the provider
 * retries (AC26).
 */
export class WebhooksService {
  constructor(private readonly d: CoreDeps) {}

  metaVerify(query: Record<string, unknown>): string {
    const r = verifyChallenge(query, this.d.config.meta.verifyToken);
    if (!r.ok) throw new AppError(403, 'VERIFY_FAILED', 'Verification failed');
    return r.challenge;
  }

  async metaReceive(rawBody: Buffer, signature: string | undefined) {
    // Hujjat (Meta, Set up Instagram Webhooks): imzo ilovaning App Secret'i bilan; bitta, sozlangan qiymat. Zaxira sir yo'q.
    if (!verifyMetaSignature(rawBody, signature, this.d.config.meta.appSecret)) {
      await this.d.redis.incr('metrics:signature_failures').catch(() => undefined);
      throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid signature');
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new AppError(400, 'INVALID_BODY', 'Invalid JSON');
    }
    const events = parseMetaWebhook(body);
    const correlationId = randomUUID();
    let stored = 0;
    for (const e of events) {
      const accountKey = e.kind === 'leadgen' ? e.pageId : e.kind === 'ig_message' || e.kind === 'ig_read' ? e.businessAccountId : 'unknown';
      const provider = e.kind === 'leadgen' ? 'META_LEADS' : 'META_DIRECT';
      const conn = accountKey !== 'unknown' ? await this.d.prisma.integrationConnection.findFirst({ where: { provider, accountId: accountKey, disconnectedAt: null }, select: { id: true, companyId: true } }) : null;
      // Direct hodisasi faqat ulangan akkauntning ID'siga (entry.id = OAuth /me user_id) mos kelsa saqlanadi; aks holda qayta ishlanmaydi.
      if (provider === 'META_DIRECT' && !conn) {
        await this.d.redis.incr('metrics:webhook_unknown_account').catch(() => undefined);
        continue;
      }
      if (await storeInboxEvent(this.d.prisma, this.d.encryptionKey, { provider: 'meta', connectionKey: accountKey, companyId: conn?.companyId ?? null, externalEventId: e.key, eventType: e.kind, payload: e, correlationId })) stored++;
      if (conn) await this.d.prisma.integrationConnection.update({ where: { id: conn.id }, data: { lastWebhookAt: this.d.clock.now() } }).catch(() => undefined);
    }
    await this.d.redis.incrby('metrics:webhook_count', events.length).catch(() => undefined);
    return { received: events.length, stored };
  }

  /** amoCRM CRM webhook: unguessable route + account check; content is only a signal. */
  async amoCrmReceive(routeToken: string, rawBody: Buffer) {
    const conn = await this.d.prisma.integrationConnection.findUnique({ where: { routeToken } });
    if (!conn || conn.provider !== 'AMOCRM_REST') throw new AppError(404, 'NOT_FOUND', 'Not found');
    const signals = parseAmoCrmWebhook(rawBody.toString('utf8'));
    const correlationId = randomUUID();
    let stored = 0;
    for (const s of signals) {
      if (s.accountId && s.accountId !== conn.accountId) continue;
      if (await storeInboxEvent(this.d.prisma, this.d.encryptionKey, { provider: 'amocrm_crm', connectionKey: routeToken, companyId: conn.companyId, externalEventId: s.key, eventType: `${s.entity}.${s.action}`, payload: s, correlationId })) stored++;
    }
    await this.d.prisma.integrationConnection.update({ where: { id: conn.id }, data: { lastWebhookAt: this.d.clock.now() } });
    return { received: signals.length, stored };
  }

  async amoChatReceive(scope: string, rawBody: Buffer, signature: string | undefined) {
    const conn = await this.d.prisma.integrationConnection.findUnique({ where: { routeToken: scope } });
    if (!conn || conn.provider !== 'AMOCRM_CHATS') throw new AppError(404, 'NOT_FOUND', 'Not found');
    if (!verifyChatsWebhook(rawBody, signature, this.d.config.amoChats.secret)) {
      await this.d.redis.incr('metrics:signature_failures').catch(() => undefined);
      throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid signature');
    }
    const reply = parseChatsWebhook(JSON.parse(rawBody.toString('utf8')));
    if (!reply) return { received: 0, stored: 0 };
    const stored = await storeInboxEvent(this.d.prisma, this.d.encryptionKey, { provider: 'amocrm_chat', connectionKey: scope, companyId: conn.companyId, externalEventId: `chat_reply:${reply.amoMessageId}`, eventType: 'chat.reply', payload: reply });
    await this.d.prisma.integrationConnection.update({ where: { id: conn.id }, data: { lastWebhookAt: this.d.clock.now() } });
    return { received: 1, stored: stored ? 1 : 0 };
  }
}
