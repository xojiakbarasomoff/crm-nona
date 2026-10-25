import { decryptSecret } from '@crm/database';
import { fetchInstagramUserProfile, ProviderError, type InstagramUserProfile } from '@crm/integrations';
import type { IntegrationConnection } from '@crm/database';
import { audit } from '../audit';
import type { CoreDeps, UserActor } from '../context';
import { requireCap } from '../scope';

/** Lid nomi shundan boshqa bo'lsa (menejer o'zgartirgan yoki kiritilgan) — avtomatik yangilanmaydi. */
export const IG_PLACEHOLDER_NAME = 'Пользователь Instagram';
/** Прежние автоматические названия (до перехода на русский) тоже считаются автоматическими. */
const LEGACY_PLACEHOLDER_NAMES = new Set(['Instagram foydalanuvchisi']);
/** Avvalgi avtomatik sarlavha: «Instagram Direct — 123456» (faqat shu shakl avtomatik hisoblanadi). */
const LEGACY_AUTO_NAME = /^Instagram Direct — \d{1,12}$/;
export const isAutoInstagramLeadName = (name: string) => name === IG_PLACEHOLDER_NAME || LEGACY_PLACEHOLDER_NAMES.has(name) || LEGACY_AUTO_NAME.test(name);

/** Qayta urinish oraliqlari (daqiqa): nazoratli backoff; MAX_ATTEMPTS dan keyin to'xtaydi (qo'lda sinxronlash mumkin). */
const BACKOFF_MIN = [1, 5, 30, 120, 720, 1440];
export const MAX_PROFILE_ATTEMPTS = BACKOFF_MIN.length;
const INTAKE_TIMEOUT_MS = 4000;

interface StoredCreds {
  accessToken: string;
}

/**
 * Instagram mijoz profili (username/name) — Instagram Login «User Profile API». Mijoz AniqLanishi username'ga emas,
 * ulangan biznes akkaunti + barqaror scoped ID'ga tayanadi; username faqat ko'rsatish uchun saqlanadi (o'zgarsa yangi kontakt/lid ochilmaydi).
 */
export class InstagramProfileService {
  constructor(private readonly d: CoreDeps) {}

  private token(conn: IntegrationConnection): string | null {
    if (!conn.credentialsEnc) return null;
    try {
      return (JSON.parse(decryptSecret(conn.credentialsEnc, this.d.encryptionKey)) as StoredCreds).accessToken ?? null;
    } catch {
      return null;
    }
  }

  /** Jonli ulanish uchun profilni oladi; xatoda null (xabar/lid yaratilishi to'xtamaydi) + xato sinfi. */
  async fetchBestEffort(conn: IntegrationConnection, scopedId: string, timeoutMs = INTAKE_TIMEOUT_MS): Promise<{ profile: InstagramUserProfile | null; error: string | null }> {
    if (conn.mode !== 'live' || !this.d.config.meta.graphVersion) return { profile: null, error: 'not_live' };
    const token = this.token(conn);
    if (!token) return { profile: null, error: 'no_token' };
    try {
      const fetchImpl = this.d.fetchImpl ?? fetch;
      const profile = await Promise.race([
        fetchInstagramUserProfile({ graphVersion: this.d.config.meta.graphVersion }, scopedId, token, fetchImpl),
        new Promise<never>((_, rej) => setTimeout(() => rej(new ProviderError('profile fetch timeout', 'transient', null)), timeoutMs).unref?.()),
      ]);
      return profile.username ? { profile, error: null } : { profile, error: 'no_username' };
    } catch (err) {
      return { profile: null, error: err instanceof ProviderError ? `${err.errorClass}${err.status ? `:${err.status}` : ''}` : 'error' };
    }
  }

  /** Muvaffaqiyatli profilni kontaktga yozadi; lid sarlavhasi FAQAT avtomatik bo'lsa yangilanadi. */
  async applyProfile(contactId: string, companyId: string, profile: InstagramUserProfile): Promise<{ leadsRenamed: number }> {
    if (!profile.username) return { leadsRenamed: 0 };
    const now = this.d.clock.now();
    const username = profile.username;
    return this.d.prisma.$transaction(async (tx) => {
      const contact = await tx.contact.findFirst({ where: { id: contactId, companyId, piiErasedAt: null, deletedAt: null }, select: { id: true } });
      if (!contact) return { leadsRenamed: 0 };
      await tx.contact.update({ where: { id: contactId }, data: { instagramUsername: username, instagramName: profile.name, instagramProfileFetchedAt: now, instagramProfileAttempts: 0, instagramProfileNextAttemptAt: null, instagramProfileError: null } });
      await tx.contactIdentifier.updateMany({ where: { companyId, contactId, type: 'instagram_scoped', active: true }, data: { displayUsername: username } });
      await tx.conversation.updateMany({ where: { companyId, contactId }, data: { peerUsername: username } });
      const leads = await tx.lead.findMany({ where: { companyId, contactId, deletedAt: null }, select: { id: true, name: true } });
      let renamed = 0;
      for (const l of leads) {
        if (!isAutoInstagramLeadName(l.name)) continue; // menejer o'zgartirgan sarlavhaga tegilmaydi
        await tx.lead.update({ where: { id: l.id }, data: { name: `@${username}` } });
        renamed++;
      }
      return { leadsRenamed: renamed };
    });
  }

  /** Muvaffaqiyatsiz urinishni qayd etadi va keyingi urinishni belgilaydi (nazoratli backoff). */
  async recordFailure(contactId: string, attempts: number, error: string): Promise<void> {
    const next = new Date(this.d.clock.now().getTime() + (BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length - 1)] ?? 1440) * 60_000);
    await this.d.prisma.contact.update({ where: { id: contactId }, data: { instagramProfileAttempts: attempts + 1, instagramProfileNextAttemptAt: attempts + 1 >= MAX_PROFILE_ATTEMPTS ? null : next, instagramProfileError: error.slice(0, 120) } });
  }

  /**
   * Username'i hali yo'q Instagram kontaktlari (yangilari ham, mavjudlari ham) uchun qayta urinish. Yangi lid/kontakt YARATMAYDI;
   * mas'ul va tarixga tegmaydi, faqat username/name va avtomatik sarlavha.
   */
  async retryDue(opts: { limit?: number; force?: boolean } = {}): Promise<{ checked: number; filled: number; failed: number; skipped: number }> {
    const now = this.d.clock.now();
    const limit = opts.limit ?? 20;
    const contacts = await this.d.prisma.contact.findMany({
      where: {
        instagramUsername: null,
        piiErasedAt: null,
        deletedAt: null,
        mergedIntoId: null,
        identifiers: { some: { type: 'instagram_scoped', active: true } },
        ...(opts.force ? {} : { instagramProfileAttempts: { lt: MAX_PROFILE_ATTEMPTS }, OR: [{ instagramProfileNextAttemptAt: null }, { instagramProfileNextAttemptAt: { lte: now } }] }),
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { identifiers: { where: { type: 'instagram_scoped', active: true }, take: 1 } },
    });
    const out = { checked: 0, filled: 0, failed: 0, skipped: 0 };
    for (const c of contacts) {
      const ident = c.identifiers[0];
      if (!ident) continue;
      const conn = await this.d.prisma.integrationConnection.findFirst({ where: { companyId: c.companyId, provider: 'META_DIRECT', accountId: ident.scope, mode: 'live', disconnectedAt: null, credentialsEnc: { not: null } } });
      if (!conn) {
        out.skipped++;
        continue;
      }
      out.checked++;
      const r = await this.fetchBestEffort(conn, ident.value, 8000);
      if (r.profile?.username) {
        await this.applyProfile(c.id, c.companyId, r.profile);
        out.filled++;
      } else {
        await this.recordFailure(c.id, c.instagramProfileAttempts, r.error ?? 'unknown');
        out.failed++;
      }
    }
    return out;
  }

  /** Administrator: hozir qayta urinish (backoff'ni e'tiborsiz qoldiradi; yangi lid yaratmaydi). */
  async syncNow(actor: UserActor) {
    requireCap(actor, 'integrations.manage');
    const r = await this.retryDue({ limit: 50, force: true });
    await audit(this.d.prisma, actor, { entityType: 'integration', entityId: actor.companyId, action: 'instagram_profiles_synced', newValue: r });
    return r;
  }
}
