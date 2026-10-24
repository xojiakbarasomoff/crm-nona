import { randomBytes } from 'node:crypto';
import type { IntegrationConnection } from '@crm/database';
import { decryptSecret, encryptSecret } from '@crm/database';
import {
  assertAllowedDomain,
  buildAuthorizeUrl,
  exchangeCode,
  hashState,
  newOAuthState,
  refreshTokens,
  type AmoTokenProvider,
  type AmoTokenSet,
  type FetchLike,
} from '@crm/integrations';
import { audit } from '../audit';
import type { CoreDeps, UserActor } from '../context';
import { unprocessable } from '../errors';
import { requireCap } from '../scope';

interface StoredAmoCreds {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
}

/**
 * amoCRM REST OAuth lifecycle (TZ §19.4, AC28, AC34).
 * Refresh runs under a per-connection row lock (SELECT … FOR UPDATE) and swaps the token pair
 * atomically; a caller that waited for the lock reuses the freshly stored pair instead of spending
 * the (already rotated) refresh token again.
 */
export class OAuthService {
  constructor(
    private readonly d: CoreDeps,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private oauthCfg() {
    const c = this.d.config.amo;
    if (!c.clientId || !c.clientSecret || !c.redirectUri) throw unprocessable('AMO_NOT_CONFIGURED', 'amoCRM integratsiyasi sozlanmagan (AMO_CLIENT_ID/SECRET/REDIRECT_URI)');
    return { clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri, allowedDomains: c.allowedDomains };
  }

  async start(actor: UserActor, domain: string) {
    requireCap(actor, 'integrations.manage');
    const cfg = this.oauthCfg();
    const d = assertAllowedDomain(domain, cfg.allowedDomains);
    const { state, stateHash } = newOAuthState();
    await this.d.prisma.oAuthState.create({
      data: { companyId: actor.companyId, provider: 'AMOCRM_REST', stateHash, sessionId: actor.sessionId!, redirectUri: cfg.redirectUri, expiresAt: new Date(this.d.clock.now().getTime() + 10 * 60_000) },
    });
    await this.d.redis.set(`oauth_domain:${stateHash}`, d, 'EX', 600);
    return { authorizeUrl: buildAuthorizeUrl(cfg, state) };
  }

  /** State must be single-use, unexpired and bound to the same session (TZ §19.4). */
  async callback(actor: UserActor, p: { code: string; state: string; referer: string }) {
    requireCap(actor, 'integrations.manage');
    const cfg = this.oauthCfg();
    const stateHash = hashState(p.state);
    const row = await this.d.prisma.oAuthState.findUnique({ where: { stateHash } });
    const now = this.d.clock.now();
    if (!row || row.usedAt || row.expiresAt <= now || row.sessionId !== actor.sessionId || row.companyId !== actor.companyId) {
      throw unprocessable('OAUTH_STATE_INVALID', 'OAuth holati yaroqsiz yoki muddati o‘tgan');
    }
    const used = await this.d.prisma.oAuthState.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
    if (used.count !== 1) throw unprocessable('OAUTH_STATE_INVALID', 'OAuth holati allaqachon ishlatilgan');
    const expectedDomain = await this.d.redis.get(`oauth_domain:${stateHash}`);
    const domain = assertAllowedDomain(p.referer, cfg.allowedDomains);
    if (expectedDomain && expectedDomain !== domain) throw unprocessable('OAUTH_DOMAIN_MISMATCH', 'amoCRM domeni boshlangan ulanishga mos emas');
    const tokens = await exchangeCode(cfg, domain, p.code, this.fetchImpl, now);
    const accountRes = await this.fetchImpl(`https://${domain}/api/v4/account`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    if (!accountRes.ok) throw unprocessable('AMO_ACCOUNT_READ_FAILED', 'amoCRM akkauntini o‘qib bo‘lmadi');
    const account = (await accountRes.json()) as { id: number };
    const conn = await this.storeTokens(actor, domain, String(account.id), tokens);
    return { connectionId: conn.id, accountId: conn.accountId };
  }

  private async storeTokens(actor: UserActor, domain: string, accountId: string, tokens: AmoTokenSet) {
    const credentialsEnc = encryptSecret(JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, tokenType: tokens.tokenType } satisfies StoredAmoCreds), this.d.encryptionKey);
    return this.d.prisma.$transaction(async (tx) => {
      const existing = await tx.integrationConnection.findFirst({ where: { companyId: actor.companyId, provider: 'AMOCRM_REST', accountId } });
      const conn = existing
        ? await tx.integrationConnection.update({
            where: { id: existing.id },
            data: { accountDomain: domain, credentialsEnc, expiresAt: tokens.expiresAt, health: 'ok', healthReason: null, disconnectedAt: null, mode: 'live', version: { increment: 1 } },
          })
        : await tx.integrationConnection.create({
            data: { companyId: actor.companyId, provider: 'AMOCRM_REST', mode: 'live', accountId, accountDomain: domain, routeToken: randomBytes(24).toString('base64url'), credentialsEnc, expiresAt: tokens.expiresAt },
          });
      await tx.outboxOperation.updateMany({ where: { companyId: actor.companyId, target: 'amocrm', state: 'paused' }, data: { state: 'pending', nextAttemptAt: this.d.clock.now() } });
      await audit(tx, actor, { entityType: 'integration', entityId: conn.id, action: 'connected', newValue: { provider: 'AMOCRM_REST', accountId, domain } });
      return conn;
    });
  }

  /** Disconnect pauses new API work; audit, orders and history are kept (AC34). */
  async disconnect(actor: UserActor, connectionId: string) {
    requireCap(actor, 'integrations.manage');
    await this.d.prisma.$transaction(async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { id: connectionId, companyId: actor.companyId } });
      if (!conn) throw unprocessable('NOT_FOUND', 'Ulanish topilmadi');
      await tx.integrationConnection.update({ where: { id: conn.id }, data: { health: 'disconnected', healthReason: 'disconnected_by_admin', disconnectedAt: this.d.clock.now(), credentialsEnc: null, version: { increment: 1 } } });
      await audit(tx, actor, { entityType: 'integration', entityId: conn.id, action: 'disconnected', oldValue: { health: conn.health } });
    });
  }

  tokenProvider(connectionId: string): AmoTokenProvider {
    let lastSeen: string | null = null;
    return {
      getAccessToken: async () => {
        const conn = await this.d.prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
        const creds = this.readCreds(conn);
        lastSeen = creds.accessToken;
        if (!conn.expiresAt || conn.expiresAt.getTime() - 60_000 > this.d.clock.now().getTime()) return creds.accessToken;
        return this.refreshWithLock(connectionId, creds.accessToken);
      },
      refresh: async () => this.refreshWithLock(connectionId, lastSeen),
    };
  }

  private readCreds(conn: IntegrationConnection): StoredAmoCreds {
    if (!conn.credentialsEnc || conn.disconnectedAt) throw Object.assign(new Error('amoCRM connection is disconnected'), { errorClass: 'forbidden' });
    return JSON.parse(decryptSecret(conn.credentialsEnc, this.d.encryptionKey)) as StoredAmoCreds;
  }

  async refreshWithLock(connectionId: string, staleAccessToken: string | null): Promise<string> {
    const cfg = this.oauthCfg();
    try {
      return await this.refreshInTx(connectionId, staleAccessToken, cfg);
    } catch (err) {
      await this.d.redis.incr('metrics:token_refresh_failures');
      await this.d.prisma.integrationConnection.update({ where: { id: connectionId }, data: { health: 'paused', healthReason: 'token_refresh_failed', lastError: (err as Error).message.slice(0, 300) } });
      throw err;
    }
  }

  private refreshInTx(connectionId: string, staleAccessToken: string | null, cfg: ReturnType<OAuthService['oauthCfg']>): Promise<string> {
    return this.d.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM integration_connections WHERE id = ${connectionId}::uuid FOR UPDATE`;
        const conn = await tx.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
        const creds = this.readCreds(conn);
        const fresh = conn.expiresAt && conn.expiresAt.getTime() - 60_000 > this.d.clock.now().getTime();
        if (staleAccessToken !== null && creds.accessToken !== staleAccessToken && fresh) return creds.accessToken;
        const tokens = await refreshTokens(cfg, conn.accountDomain!, creds.refreshToken, this.fetchImpl, this.d.clock.now());
        await tx.integrationConnection.update({
          where: { id: conn.id },
          data: {
            credentialsEnc: encryptSecret(JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, tokenType: tokens.tokenType }), this.d.encryptionKey),
            expiresAt: tokens.expiresAt,
            health: 'ok',
            healthReason: null,
            version: { increment: 1 },
          },
        });
        await this.d.redis.incr('metrics:token_refresh_success');
        return tokens.accessToken;
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
  }
}
