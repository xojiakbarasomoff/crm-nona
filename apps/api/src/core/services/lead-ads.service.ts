import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '@crm/database';
import { buildLeadAdsAuthorizeUrl, hashState, LEAD_ADS_SCOPES, LeadAdsLoginClient, newOAuthState, type FetchLike, type LeadAdsPage } from '@crm/integrations';
import { audit } from '../audit';
import type { CoreDeps, UserActor } from '../context';
import { conflict, unprocessable } from '../errors';
import { requireCap } from '../scope';

interface PendingPages { pages: LeadAdsPage[] }

/** Facebook Login for Lead Ads; separate Page credentials, no changes to Instagram Direct. */
export class LeadAdsService {
  constructor(private readonly d: CoreDeps, private readonly fetchImpl: FetchLike = fetch) {}

  private config() {
    const m = this.d.config.meta;
    if (!m.appId || !m.appSecret || !/^v\d+\.\d+$/.test(m.graphVersion) || !m.verifyToken) throw unprocessable('LEAD_ADS_NOT_CONFIGURED', 'Подключение рекламных форм не настроено. Администратору нужно указать параметры Meta и вебхука.');
    return { appId: m.appId, appSecret: m.appSecret, graphVersion: m.graphVersion, redirectUri: m.leadsRedirectUri, ...(m.leadsConfigId ? { configId: m.leadsConfigId } : {}) };
  }

  private client() { return new LeadAdsLoginClient(this.config(), this.fetchImpl); }
  private key(actor: UserActor) { return `lead_ads_pages:${actor.companyId}:${actor.id}:${actor.sessionId}`; }

  private async pending(actor: UserActor): Promise<PendingPages> {
    const raw = await this.d.redis.get(this.key(actor));
    if (!raw) throw unprocessable('LEAD_ADS_AUTH_EXPIRED', 'Выбор страницы устарел. Подключитесь через Facebook ещё раз.');
    return JSON.parse(decryptSecret(raw, this.d.encryptionKey)) as PendingPages;
  }

  async status(actor: UserActor) {
    requireCap(actor, 'integrations.manage');
    const m = this.d.config.meta;
    const [connections, pending] = await Promise.all([
      this.d.prisma.integrationConnection.findMany({ where: { companyId: actor.companyId, provider: 'META_LEADS', mode: 'live' }, orderBy: { createdAt: 'asc' } }),
      this.pending(actor).catch(() => null),
    ]);
    return {
      configured: !!(m.appId && m.appSecret && /^v\d+\.\d+$/.test(m.graphVersion) && m.verifyToken),
      oauthRedirectUri: m.leadsRedirectUri,
      pendingPages: (pending?.pages ?? []).map(p => ({ id: p.id, name: p.name, instagramUsername: p.instagramUsername })),
      connections: connections.map(c => {
        const s = c.settings as Record<string, unknown>;
        const blocked = c.disconnectedAt || c.health === 'paused' || c.health === 'disconnected';
        return { id: c.id, pageId: c.accountId, pageName: c.accountDomain ?? c.accountId, formIds: Array.isArray(s.formIds) ? s.formIds : [], webhookSubscribed: s.webhookSubscribed === true, verifiedWebhookAt: typeof s.verifiedWebhookAt === 'string' ? s.verifiedWebhookAt : null, lastImportedAt: typeof s.lastImportedAt === 'string' ? s.lastImportedAt : null, state: blocked || c.healthReason === 'lead_ads_retrieval_failed' ? 'problem' : s.webhookSubscribed && s.verifiedWebhookAt ? 'ready' : 'awaiting_test', healthReason: c.healthReason, lastError: c.lastError };
      }),
    };
  }

  async start(actor: UserActor) {
    requireCap(actor, 'integrations.manage');
    const c = this.config();
    const { state, stateHash } = newOAuthState();
    await this.d.redis.del(this.key(actor));
    await this.d.prisma.oAuthState.create({ data: { companyId: actor.companyId, provider: 'META_LEADS', stateHash, sessionId: actor.sessionId!, redirectUri: c.redirectUri, expiresAt: new Date(this.d.clock.now().getTime() + 600_000) } });
    return { authorizeUrl: buildLeadAdsAuthorizeUrl(c, state) };
  }

  async callback(actor: UserActor, p: { code: string; state: string }) {
    requireCap(actor, 'integrations.manage');
    const c = this.config();
    const now = this.d.clock.now();
    const row = await this.d.prisma.oAuthState.findUnique({ where: { stateHash: hashState(p.state) } });
    if (!row || row.provider !== 'META_LEADS' || row.usedAt || row.expiresAt <= now || row.sessionId !== actor.sessionId || row.companyId !== actor.companyId || row.redirectUri !== c.redirectUri) throw unprocessable('OAUTH_STATE_INVALID', 'Состояние авторизации недействительно или устарело.');
    const used = await this.d.prisma.oAuthState.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
    if (used.count !== 1) throw unprocessable('OAUTH_STATE_INVALID', 'Состояние авторизации уже использовано.');
    const client = this.client();
    const token = await client.exchangeCode(p.code);
    const granted = await client.permissions(token);
    if (LEAD_ADS_SCOPES.some(scope => !granted.includes(scope))) throw unprocessable('LEAD_ADS_PERMISSION_MISSING', 'Facebook не предоставил все разрешения для рекламных форм. Проверьте доступ к странице и лидам в Meta Business.');
    const pages = await client.pages(token);
    if (!pages.length) throw unprocessable('LEAD_ADS_NO_PAGES', 'Нет доступных страниц Facebook. Нужен доступ к странице, связанной с рекламной формой NONA Travel.');
    // Page tokens are encrypted, scoped to this admin session, expire after ten minutes, never returned to UI.
    await this.d.redis.set(this.key(actor), encryptSecret(JSON.stringify({ pages }), this.d.encryptionKey), 'EX', 600);
  }

  async forms(actor: UserActor, pageId: string) {
    requireCap(actor, 'integrations.manage');
    const page = (await this.pending(actor)).pages.find(p => p.id === pageId);
    if (!page) throw unprocessable('LEAD_ADS_PAGE_INVALID', 'Выберите страницу из списка Facebook.');
    return { items: await this.client().forms(page.id, page.accessToken) };
  }

  async connect(actor: UserActor, p: { pageId: string; formIds: string[] }) {
    requireCap(actor, 'integrations.manage');
    const page = (await this.pending(actor)).pages.find(x => x.id === p.pageId);
    if (!page) throw unprocessable('LEAD_ADS_PAGE_INVALID', 'Выберите страницу из списка Facebook.');
    const other = await this.d.prisma.integrationConnection.findFirst({ where: { provider: 'META_LEADS', accountId: page.id, companyId: { not: actor.companyId }, disconnectedAt: null }, select: { id: true } });
    if (other) throw conflict('LEAD_ADS_PAGE_IN_USE', 'Страница уже подключена к другой компании.');
    const client = this.client();
    const available = await client.forms(page.id, page.accessToken);
    const formIds = [...new Set(p.formIds)];
    if (!formIds.length || formIds.some(id => !available.some(f => f.id === id))) throw unprocessable('LEAD_ADS_FORM_INVALID', 'Выберите доступные рекламные формы этой страницы.');
    await client.subscribe(page.id, page.accessToken);
    const id = await this.d.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`lead_ads_page:${page.id}`}, 0))`;
      if (await tx.integrationConnection.findFirst({ where: { provider: 'META_LEADS', accountId: page.id, companyId: { not: actor.companyId }, disconnectedAt: null }, select: { id: true } })) throw conflict('LEAD_ADS_PAGE_IN_USE', 'Страница уже подключена к другой компании.');
      const conn = await tx.integrationConnection.upsert({
        where: { companyId_provider_accountId: { companyId: actor.companyId, provider: 'META_LEADS', accountId: page.id } },
        create: { companyId: actor.companyId, provider: 'META_LEADS', mode: 'live', accountId: page.id, accountDomain: page.name, routeToken: randomBytes(24).toString('hex'), credentialsEnc: encryptSecret(JSON.stringify({ accessToken: page.accessToken }), this.d.encryptionKey), health: 'degraded', healthReason: 'awaiting_lead_ads_test', settings: { formIds, forms: available.filter(f => formIds.includes(f.id)).map(f => ({ id: f.id, name: f.name, status: f.status })), webhookSubscribed: true, instagramUsername: page.instagramUsername } },
        update: { mode: 'live', accountDomain: page.name, credentialsEnc: encryptSecret(JSON.stringify({ accessToken: page.accessToken }), this.d.encryptionKey), disconnectedAt: null, expiresAt: null, health: 'degraded', healthReason: 'awaiting_lead_ads_test', lastError: null, settings: { formIds, forms: available.filter(f => formIds.includes(f.id)).map(f => ({ id: f.id, name: f.name, status: f.status })), webhookSubscribed: true, instagramUsername: page.instagramUsername }, version: { increment: 1 } },
      });
      // No automatic history import on connect: old leads are loaded only by an explicit admin backfill (/lead-ads/backfill).
      await audit(tx, actor, { entityType: 'integration', entityId: conn.id, action: 'lead_ads_connected', newValue: { pageId: page.id, formIds, mode: 'live' } });
      return conn.id;
    });
    return { id, state: 'awaiting_test' };
  }
}

/** A backfill proves retrieval; only a signed webhook processed into a lead proves live delivery. */
export async function markLeadAdsImported(d: CoreDeps, connectionId: string, correlationId: string) {
  await d.prisma.$transaction(async tx => {
    // Parallel webhook/backfill workers must not overwrite each other's verification evidence.
    await tx.$queryRaw`SELECT id FROM integration_connections WHERE id = ${connectionId}::uuid FOR UPDATE`;
    const conn = await tx.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
    if (conn.mode !== 'live' || conn.provider !== 'META_LEADS' || conn.disconnectedAt) return;
    const webhook = !correlationId.startsWith('backfill:');
    const now = d.clock.now();
    const old = conn.settings as Record<string, unknown>;
    const settings = { ...old, lastImportedAt: now.toISOString(), ...(webhook ? { verifiedWebhookAt: now.toISOString() } : {}) };
    const canPromote = conn.health === 'degraded' && ['awaiting_lead_ads_test', 'lead_ads_retrieval_failed'].includes(conn.healthReason ?? '');
    await tx.integrationConnection.update({ where: { id: conn.id }, data: { settings, lastSyncAt: now, ...((webhook || old.verifiedWebhookAt) && canPromote ? { health: 'ok', healthReason: null, lastError: null } : {}) } });
  });
}
