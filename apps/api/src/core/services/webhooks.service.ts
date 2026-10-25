import { createHmac, randomUUID } from 'node:crypto';
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

  /**
   * Har bir webhook obyekti uchun BITTA imzo siri (zaxira yo'q):
   * - `object: "instagram"` (Instagram Login, Direct) → Instagram app secret (INSTAGRAM_APP_SECRET). Haqiqiy Meta test hodisasi
   *   (2026-10-25) aynan shu sir bilan imzolangani log orqali tasdiqlandi. INSTAGRAM_APP_SECRET sozlanmagan bo'lsa (demo/eski muhit) — META_APP_SECRET.
   * - boshqa obyektlar (Lead Ads, `page`) → META_APP_SECRET.
   * Obyekt turi faqat kalitni tanlaydi; hodisa baribir shu kalit bilan imzo o'tmaguncha qabul qilinmaydi.
   */
  signingSecretFor(rawBody: Buffer): { secret: string; kind: 'instagram' | 'meta' } {
    const m = this.d.config.meta;
    let object: unknown;
    try {
      object = (JSON.parse(rawBody.toString('utf8')) as { object?: unknown }).object;
    } catch {
      object = undefined;
    }
    return object === 'instagram' && m.instagram.appSecret ? { secret: m.instagram.appSecret, kind: 'instagram' } : { secret: m.appSecret, kind: 'meta' };
  }

  async metaReceive(rawBody: Buffer, signature: string | undefined) {
    const { secret, kind } = this.signingSecretFor(rawBody);
    if (!verifyMetaSignature(rawBody, signature, secret)) {
      await this.d.redis.incr('metrics:signature_failures').catch(() => undefined);
      // Diagnostika (hodisa BARIBIR rad etiladi): sirlar logga chiqmaydi, faqat tanlangan tur va boshqa sir bilan mos kelish-kelmasligi.
      const other = kind === 'instagram' ? this.d.config.meta.appSecret : this.d.config.meta.instagram.appSecret;
      const hex = signature?.startsWith('sha256=') ? signature.slice(7) : null;
      this.d.logger.warn(
        {
          selectedSecret: kind,
          signatureHeaderPresent: !!signature,
          signatureHeaderFormatOk: !!hex && /^[0-9a-f]{64}$/i.test(hex),
          bodyBytes: rawBody.length,
          wouldMatchOtherSecret: !!(hex && other && createHmac('sha256', other).update(rawBody).digest('hex') === hex.toLowerCase()),
        },
        'meta webhook signature rejected',
      );
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
        // Diagnostika: qaysi akkaunt ID tashlandi va qaysilari ulangan (ID'lar sir emas; xabar matni/yuboruvchi logga chiqmaydi).
        const connected = await this.d.prisma.integrationConnection.findMany({ where: { provider: 'META_DIRECT', mode: 'live', disconnectedAt: null }, select: { accountId: true } }).catch(() => []);
        const entryIds = Array.isArray((body as { entry?: unknown })?.entry) ? ((body as { entry: Array<{ id?: unknown }> }).entry.map((x) => String(x?.id ?? '')).slice(0, 5)) : [];
        this.d.logger.warn({ kind: e.kind, droppedAccountKey: accountKey, entryIds, connectedAccountIds: connected.map((c) => c.accountId) }, 'meta direct webhook dropped: account id does not match a connected account');
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
