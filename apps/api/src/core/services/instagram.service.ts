import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '@crm/database';
import {
  buildInstagramAuthorizeUrl,
  exchangeForLongLivedToken,
  exchangeInstagramCode,
  fetchInstagramProfile,
  hashState,
  newOAuthState,
  refreshLongLivedToken,
  subscribeInstagramWebhooks,
  type FetchLike,
  type InstagramLoginConfig,
} from '@crm/integrations';
import { audit } from '../audit';
import { notify } from '../events';
import type { CoreDeps, UserActor } from '../context';
import { unprocessable } from '../errors';
import { requireCap } from '../scope';
import { AWAITING_LIVE_VERIFICATION, liveState, WEBHOOK_UNCONFIRMED } from './live-verification';

interface StoredInstagramCreds {
  accessToken: string;
  igUserId: string;
  username: string | null;
  issuedAt: string;
}

/** Professional account types allowed to use the messaging API. PERSONAL accounts cannot be connected. */
const MESSAGING_ACCOUNT_TYPES = new Set(['BUSINESS', 'MEDIA_CREATOR', 'Business', 'Media_Creator']);

/**
 * Instagram API with Instagram Login: connect an Instagram professional account to Direct (TZ §9).
 * The account OWNER authorizes in their own Instagram session; this service never sees a password.
 * The long-lived token (~60 days) is stored encrypted and refreshed by the worker. This path is separate from
 * Facebook Login / Page tokens (Lead Ads), which stay untouched.
 */
export class InstagramService {
  constructor(
    private readonly d: CoreDeps,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private cfg(): InstagramLoginConfig {
    const m = this.d.config.meta;
    if (!m.instagram.appId || !m.instagram.appSecret || !m.graphVersion) {
      throw unprocessable('INSTAGRAM_NOT_CONFIGURED', 'Instagram Login sozlanmagan (INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, META_GRAPH_VERSION)');
    }
    return { appId: m.instagram.appId, appSecret: m.instagram.appSecret, redirectUri: m.instagram.redirectUri, graphVersion: m.graphVersion };
  }

  /** Public, secret-free summary for the settings screen and the setup runbook. */
  async status(companyId: string) {
    const m = this.d.config.meta;
    const conns = await this.d.prisma.integrationConnection.findMany({ where: { companyId, provider: 'META_DIRECT', mode: 'live' }, orderBy: { createdAt: 'asc' } });
    return {
      connections: conns.map((c) => {
        const s = (c.settings ?? {}) as Record<string, unknown>;
        return { id: c.id, accountId: c.accountId, username: (s.username as string | null) ?? null, disconnected: !!c.disconnectedAt, health: c.health, healthReason: c.healthReason, state: c.disconnectedAt ? 'disconnected' : liveState(s, c.health, c.healthReason), verifiedInboundAt: (s.verifiedInboundAt as string | null) ?? null, verifiedOutboundAt: (s.verifiedOutboundAt as string | null) ?? null, expiresAt: c.expiresAt };
      }),
      configured: !!(m.instagram.appId && m.instagram.appSecret && m.graphVersion),
      oauthRedirectUri: m.instagram.redirectUri,
      webhookCallbackPath: '/webhooks/meta',
      verifyTokenConfigured: !!m.verifyToken,
      /** Webhook imzosi: faqat META_APP_SECRET (Meta hujjati: «your app's App Secret»). */
      signatureSecretConfigured: !!m.appSecret,
      graphVersion: m.graphVersion || null,
    };
  }

  /**
   * Diagnostika (faqat o'qish): Meta'dan akkauntning haqiqiy `subscribed_apps` holatini so'raydi.
   * Token ham, javob tanasi ham qaytarilmaydi — faqat ilova nomi va obuna maydonlari.
   */
  async subscriptionCheck(actor: UserActor) {
    requireCap(actor, 'integrations.manage');
    const m = this.d.config.meta;
    const conns = await this.d.prisma.integrationConnection.findMany({ where: { companyId: actor.companyId, provider: 'META_DIRECT', mode: 'live', disconnectedAt: null, credentialsEnc: { not: null } } });
    const out: Array<{ accountId: string; httpStatus: number | null; apps: Array<{ name: string | null; id: string | null; fields: string[] }>; error: string | null; profileIds?: { id: string | null; user_id: string | null } }> = [];
    for (const conn of conns) {
      const creds = JSON.parse(decryptSecret(conn.credentialsEnc!, this.d.encryptionKey)) as StoredInstagramCreds;
      try {
        const url = `https://graph.instagram.com/${m.graphVersion}/${conn.accountId}/subscribed_apps?access_token=${encodeURIComponent(creds.accessToken)}`;
        const res = await this.fetchImpl(url, { method: 'GET' });
        const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: string; name?: string; subscribed_fields?: string[] }>; error?: { message?: string; code?: number } };
        // /me: `id` (app-scoped) va `user_id` (professional account ID) farq qilishi mumkin; webhook qaysi biri bilan kelishini aniqlash uchun ikkalasi ham ko'rsatiladi.
        const meRes = await this.fetchImpl(`https://graph.instagram.com/${m.graphVersion}/me?fields=id,user_id&access_token=${encodeURIComponent(creds.accessToken)}`, { method: 'GET' });
        const me = (await meRes.json().catch(() => ({}))) as { id?: string; user_id?: string };
        out.push({
          accountId: conn.accountId,
          httpStatus: res.status,
          apps: (body.data ?? []).map((a) => ({ name: a.name ?? null, id: a.id ?? null, fields: a.subscribed_fields ?? [] })),
          error: body.error ? `code=${body.error.code ?? '?'}` : null,
          profileIds: { id: me.id ?? null, user_id: me.user_id ?? null },
        });
      } catch (err) {
        out.push({ accountId: conn.accountId, httpStatus: null, apps: [], error: (err as Error).name });
      }
    }
    return { graphVersion: m.graphVersion || null, connections: out };
  }

  /**
   * Mavjud ulanishga `/me → id` (app-scoped) ni yozadi (token orqali o'sha akkauntning o'zi aytgan ID). Webhook `recipient.id` ikkala
   * qiymatdan biri bilan kelishi mumkin; mos kelish faqat SHU ulanishning o'z ikki ID'si bilan bo'ladi, boshqa akkaunt qabul qilinmaydi.
   */
  async syncProfileIds(actor: UserActor) {
    requireCap(actor, 'integrations.manage');
    const cfg = this.cfg();
    const conns = await this.d.prisma.integrationConnection.findMany({ where: { companyId: actor.companyId, provider: 'META_DIRECT', mode: 'live', disconnectedAt: null, credentialsEnc: { not: null } } });
    const out: Array<{ accountId: string; appScopedIdStored: boolean }> = [];
    for (const conn of conns) {
      const creds = JSON.parse(decryptSecret(conn.credentialsEnc!, this.d.encryptionKey)) as StoredInstagramCreds;
      const profile = await fetchInstagramProfile(cfg, creds.accessToken, this.fetchImpl);
      const ok = profile.userId === conn.accountId && !!profile.appScopedId;
      if (ok) await this.d.prisma.integrationConnection.update({ where: { id: conn.id }, data: { settings: { ...((conn.settings ?? {}) as object), appScopedId: profile.appScopedId } as object, version: { increment: 1 } } });
      out.push({ accountId: conn.accountId, appScopedIdStored: ok });
    }
    return { connections: out };
  }

  async start(actor: UserActor) {
    requireCap(actor, 'integrations.manage');
    const cfg = this.cfg();
    const { state, stateHash } = newOAuthState();
    await this.d.prisma.oAuthState.create({
      data: { companyId: actor.companyId, provider: 'META_DIRECT', stateHash, sessionId: actor.sessionId!, redirectUri: cfg.redirectUri, expiresAt: new Date(this.d.clock.now().getTime() + 10 * 60_000) },
    });
    return { authorizeUrl: buildInstagramAuthorizeUrl(cfg, state) };
  }

  /** State: single use, unexpired, bound to the same session and company. */
  async callback(actor: UserActor, p: { code: string; state: string }) {
    requireCap(actor, 'integrations.manage');
    const cfg = this.cfg();
    const now = this.d.clock.now();
    const row = await this.d.prisma.oAuthState.findUnique({ where: { stateHash: hashState(p.state) } });
    if (!row || row.provider !== 'META_DIRECT' || row.usedAt || row.expiresAt <= now || row.sessionId !== actor.sessionId || row.companyId !== actor.companyId) {
      throw unprocessable('OAUTH_STATE_INVALID', 'OAuth holati yaroqsiz yoki muddati o‘tgan');
    }
    const used = await this.d.prisma.oAuthState.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
    if (used.count !== 1) throw unprocessable('OAUTH_STATE_INVALID', 'OAuth holati allaqachon ishlatilgan');

    // Instagram appends "#_" to the code in the redirect; it is not part of the code.
    const code = p.code.replace(/#_$/, '');
    const short = await exchangeInstagramCode(cfg, code, this.fetchImpl);
    const long = await exchangeForLongLivedToken(cfg, short.accessToken, now, this.fetchImpl);
    const profile = await fetchInstagramProfile(cfg, long.accessToken, this.fetchImpl);
    if (profile.accountType && !MESSAGING_ACCOUNT_TYPES.has(profile.accountType)) {
      throw unprocessable('INSTAGRAM_NOT_PROFESSIONAL', 'Akkaunt Instagram professional (Business/Creator) emas: Direct API faqat professional akkauntlar uchun');
    }
    if (!short.permissions.includes('instagram_business_manage_messages') && short.permissions.length > 0) {
      throw unprocessable('INSTAGRAM_PERMISSION_MISSING', 'instagram_business_manage_messages ruxsati berilmadi');
    }
    const subscribed = await subscribeInstagramWebhooks(cfg, profile.userId, long.accessToken, undefined, this.fetchImpl).catch(() => false);

    const credentialsEnc = encryptSecret(JSON.stringify({ accessToken: long.accessToken, igUserId: profile.userId, username: profile.username, issuedAt: now.toISOString() } satisfies StoredInstagramCreds), this.d.encryptionKey);
    // Credential kiritilgani «tayyor» degani emas: haqiqiy kiruvchi va chiquvchi sinov o'tmaguncha degraded.
    const settings = { username: profile.username, accountType: profile.accountType, login: 'instagram_login', appScopedId: profile.appScopedId, webhookSubscribed: subscribed, permissions: short.permissions, verifiedInboundAt: null, verifiedOutboundAt: null };
    const reason = subscribed ? AWAITING_LIVE_VERIFICATION : WEBHOOK_UNCONFIRMED;
    const conn = await this.d.prisma.$transaction(async (tx) => {
      const existing = await tx.integrationConnection.findFirst({ where: { companyId: actor.companyId, provider: 'META_DIRECT', accountId: profile.userId } });
      const saved = existing
        ? await tx.integrationConnection.update({
            where: { id: existing.id },
            data: { mode: 'live', credentialsEnc, expiresAt: long.expiresAt, health: 'degraded', healthReason: reason, disconnectedAt: null, settings, version: { increment: 1 } },
          })
        : await tx.integrationConnection.create({
            data: { companyId: actor.companyId, provider: 'META_DIRECT', mode: 'live', accountId: profile.userId, routeToken: randomBytes(24).toString('base64url'), credentialsEnc, expiresAt: long.expiresAt, health: 'degraded', healthReason: reason, settings },
          });
      await audit(tx, actor, { entityType: 'integration', entityId: saved.id, action: 'connected', newValue: { provider: 'META_DIRECT', login: 'instagram_login', accountId: profile.userId, username: profile.username, webhookSubscribed: subscribed } });
      return saved;
    });
    return { connectionId: conn.id, accountId: conn.accountId, username: profile.username, webhookSubscribed: subscribed };
  }

  /**
   * Worker: refreshes long-lived tokens that expire within `windowDays` (a token must be ≥24h old to refresh).
   * A failed refresh marks the connection degraded with a visible reason; outbound sends then stop being accepted
   * only once the token is truly expired. Returns counts for the heartbeat.
   */
  async refreshDue(windowDays = 14): Promise<{ refreshed: number; failed: number }> {
    const now = this.d.clock.now();
    const horizon = new Date(now.getTime() + windowDays * 86_400_000);
    const conns = await this.d.prisma.integrationConnection.findMany({ where: { provider: 'META_DIRECT', mode: 'live', disconnectedAt: null, credentialsEnc: { not: null }, expiresAt: { lte: horizon } } });
    let refreshed = 0;
    let failed = 0;
    for (const conn of conns) {
      const creds = JSON.parse(decryptSecret(conn.credentialsEnc!, this.d.encryptionKey)) as StoredInstagramCreds;
      if (now.getTime() - new Date(creds.issuedAt).getTime() < 24 * 3600_000) continue; // too young to refresh
      try {
        const t = await refreshLongLivedToken(creds.accessToken, now, this.fetchImpl);
        await this.d.prisma.integrationConnection.update({
          where: { id: conn.id },
          data: { credentialsEnc: encryptSecret(JSON.stringify({ ...creds, accessToken: t.accessToken, issuedAt: now.toISOString() } satisfies StoredInstagramCreds), this.d.encryptionKey), expiresAt: t.expiresAt, lastError: null, version: { increment: 1 }, ...(conn.healthReason === 'token_refresh_failed' ? { health: 'degraded' as const, healthReason: AWAITING_LIVE_VERIFICATION } : {}) },
        });
        refreshed++;
      } catch (err) {
        failed++;
        const expired = conn.expiresAt ? conn.expiresAt <= now : false;
        await this.d.prisma.integrationConnection.update({
          where: { id: conn.id },
          data: { health: expired ? 'paused' : 'degraded', healthReason: expired ? 'token_expired_reconnect_required' : 'token_refresh_failed', lastError: (err as Error).message.slice(0, 300) },
        });
      }
    }
    return { refreshed, failed };
  }

  /** Meta "Deauthorize callback": the account owner removed the app — pause, keep history (like amoCRM disconnect). */
  async handleDeauthorize(igUserId: string) {
    const conns = await this.d.prisma.integrationConnection.findMany({ where: { provider: 'META_DIRECT', accountId: igUserId, disconnectedAt: null } });
    for (const conn of conns) {
      await this.d.prisma.$transaction(async (tx) => {
        await tx.integrationConnection.update({ where: { id: conn.id }, data: { health: 'disconnected', healthReason: 'deauthorized_by_account_owner', disconnectedAt: this.d.clock.now(), credentialsEnc: null, version: { increment: 1 } } });
        await tx.auditLog.create({ data: { companyId: conn.companyId, actorType: 'integration', entityType: 'integration', entityId: conn.id, action: 'deauthorized', correlationId: randomBytes(8).toString('hex'), newValue: { provider: 'META_DIRECT', accountId: igUserId } } });
      });
    }
    return conns.length;
  }

  /**
   * Meta "Data deletion request" callback. Avtomatik o'chirish YO'Q: ulanish uziladi (token o'chiriladi) va barcha faol administratorlarga
   * ilova ichidagi bildirishnoma ketadi — mijoz yozishmalarini «Mijoz kartasi → Shaxsiy ma'lumotlarni o'chirish» orqali administrator bajaradi.
   */
  async handleDataDeletionRequest(igUserId: string, code: string) {
    const conns = igUserId ? await this.d.prisma.integrationConnection.findMany({ where: { provider: 'META_DIRECT', accountId: igUserId, disconnectedAt: null } }) : [];
    const company = conns[0] ? { id: conns[0].companyId } : await this.d.prisma.company.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!company) return { disconnected: 0, notified: 0 };
    const admins = await this.d.prisma.user.findMany({ where: { companyId: company.id, role: 'ADMIN', status: 'active' }, select: { id: true } });
    await this.d.prisma.$transaction(async (tx) => {
      for (const conn of conns) {
        await tx.integrationConnection.update({ where: { id: conn.id }, data: { health: 'disconnected', healthReason: 'data_deletion_requested', disconnectedAt: this.d.clock.now(), credentialsEnc: null, version: { increment: 1 } } });
      }
      for (const a of admins) {
        await notify(tx, {
          companyId: company.id,
          userId: a.id,
          kind: 'ig_data_deletion_request',
          dedupeKey: `ig_data_deletion:${code}`,
          title: 'Meta: ma’lumotni o‘chirish so‘rovi',
          body: `Tasdiqlash kodi: ${code}. Instagram bilan bog‘liq mijoz yozishmalarini «Mijoz kartasi → Shaxsiy ma’lumotlarni o‘chirish» orqali ko‘rib chiqing. Ulanish uzildi: ${conns.length}.`,
          link: '/integrations',
        });
      }
      await tx.auditLog.create({ data: { companyId: company.id, actorType: 'integration', entityType: 'integration', entityId: conns[0]?.id ?? company.id, action: 'meta_data_deletion_requested', correlationId: code, newValue: { provider: 'META_DIRECT', matchedConnections: conns.length } } });
    });
    return { disconnected: conns.length, notified: admins.length };
  }
}
