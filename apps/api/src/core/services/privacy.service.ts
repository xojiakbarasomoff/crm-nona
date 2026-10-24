import { createHash } from 'node:crypto';
import type { Tx } from '@crm/database';
import { audit } from '../audit';
import { systemActor, type CoreDeps, type UserActor } from '../context';
import { forbidden, unprocessable } from '../errors';
import { assertFound } from '../scope';

export interface RetentionPolicy {
  confirmed: boolean;
  rawWebhookDays: number;
  technicalLogDays: number;
  messageContentMonths: number;
  confirmedBy?: string;
  confirmedAt?: string;
}

export const ERASED_NAME = 'O‘chirilgan mijoz';
const hashId = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Retention purge and PII erasure (TZ §21).
 * - Purges run only after the company confirmed the policy; an unconfirmed proposal is never a
 *   silent default.
 * - Erasure anonymizes the contact, identifiers, messages, form answers, passengers and files;
 *   financial rows (payments, order amounts) are kept per policy; amoCRM/Instagram copies need an
 *   operator action and are flagged. A tombstone survives backups and is re-applied after restore.
 */
export class PrivacyService {
  constructor(private readonly d: CoreDeps) {}

  async policy(companyId: string): Promise<RetentionPolicy | null> {
    const c = await this.d.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    return ((c.settings ?? {}) as { retention?: RetentionPolicy }).retention ?? null;
  }

  async confirmPolicy(actor: UserActor, policy: Omit<RetentionPolicy, 'confirmed' | 'confirmedBy' | 'confirmedAt'>) {
    if (actor.role !== 'ADMIN') throw forbidden();
    const company = await this.d.prisma.company.findUniqueOrThrow({ where: { id: actor.companyId } });
    const next: RetentionPolicy = { ...policy, confirmed: true, confirmedBy: actor.id, confirmedAt: this.d.clock.now().toISOString() };
    await this.d.prisma.company.update({ where: { id: actor.companyId }, data: { settings: { ...(company.settings as object), retention: next } as object } });
    await audit(this.d.prisma, actor, { entityType: 'company', entityId: actor.companyId, action: 'retention_policy_confirmed', oldValue: (company.settings as { retention?: unknown }).retention ?? null, newValue: next });
    return next;
  }

  async runRetention(companyId: string) {
    const policy = await this.policy(companyId);
    const now = this.d.clock.now();
    if (!policy?.confirmed) return { skipped: 'policy_not_confirmed' as const };
    const webhookCutoff = new Date(now.getTime() - policy.rawWebhookDays * 86400_000);
    const messageCutoff = new Date(now);
    messageCutoff.setUTCMonth(messageCutoff.getUTCMonth() - policy.messageContentMonths);

    // Keep the dedupe key, drop the raw payload (TZ: raw webhook 30 days).
    const webhooks = await this.d.prisma.webhookInbox.updateMany({
      where: { companyId, receivedAt: { lt: webhookCutoff }, state: { in: ['done', 'ignored', 'dead'] }, NOT: { payloadEnc: 'purged' } },
      data: { payloadEnc: 'purged' },
    });
    const messages = await this.d.prisma.message.updateMany({
      where: { companyId, createdAt: { lt: messageCutoff }, contentPurgedAt: null },
      data: { content: null, attachments: [], contentPurgedAt: now },
    });
    const expiredFiles = await this.d.prisma.attachment.findMany({ where: { companyId, deletedAt: null, retentionUntil: { lt: now } } });
    for (const f of expiredFiles) {
      await this.d.adapters.storage.delete(f.objectKey);
      await this.d.prisma.attachment.update({ where: { id: f.id }, data: { deletedAt: now } });
    }
    const idem = await this.d.prisma.idempotencyKey.deleteMany({ where: { companyId, expiresAt: { lt: now } } });
    const oauth = await this.d.prisma.oAuthState.deleteMany({ where: { companyId, expiresAt: { lt: new Date(now.getTime() - 86400_000) } } });
    const users = await this.d.prisma.user.findMany({ where: { companyId }, select: { id: true } });
    const sessions = await this.d.prisma.session.deleteMany({ where: { userId: { in: users.map((u) => u.id) }, expiresAt: { lt: new Date(now.getTime() - 30 * 86400_000) } } });
    const result = { webhookPayloadsPurged: webhooks.count, messageContentsPurged: messages.count, filesDeleted: expiredFiles.length, idempotencyKeysDeleted: idem.count, oauthStatesDeleted: oauth.count, sessionsDeleted: sessions.count, technicalLogs: `log infrastructure (${policy.technicalLogDays} d)` };
    await audit(this.d.prisma, systemActor(companyId, 'retention'), { entityType: 'company', entityId: companyId, action: 'retention_run', newValue: result });
    return result;
  }

  /** Erase or anonymize a person's data (admin only). */
  async eraseContact(actor: UserActor, contactId: string, reason: string) {
    if (actor.role !== 'ADMIN') throw forbidden();
    if (!reason?.trim()) throw unprocessable('REASON_REQUIRED', 'Sabab majburiy', { reason: 'required' });
    const files = await this.d.prisma.$transaction(async (tx) => {
      const contact = assertFound(await tx.contact.findFirst({ where: { id: contactId, companyId: actor.companyId } }), 'Mijoz');
      const identifiers = await tx.contactIdentifier.findMany({ where: { companyId: actor.companyId, contactId } });
      await tx.piiTombstone.upsert({
        where: { companyId_contactId: { companyId: actor.companyId, contactId } },
        create: { companyId: actor.companyId, contactId, amoContactId: contact.amoContactId, identifierHashes: identifiers.map((i) => hashId(`${i.type}|${i.scope}|${i.value}`)), reason, erasedById: actor.id },
        update: {},
      });
      const r = await this.anonymize(tx, actor.companyId, contactId);
      const { LeadsService } = await import('./leads.service');
      const leads = await tx.lead.findMany({ where: { companyId: actor.companyId, contactId }, select: { id: true } });
      if (leads[0]) {
        await new LeadsService(this.d).createCrmTask(tx, {
          companyId: actor.companyId,
          key: `pii_erase:${contactId}`,
          entityId: leads[0].id,
          kind: 'pii_provider_review',
          text: 'Shaxsiy ma’lumot o‘chirildi: amoCRM kontakti, chat tarixi va Instagram yozishmasini kompaniya siyosati bo‘yicha qo‘lda o‘chiring/anonimlang.',
          responsibleUserId: actor.id,
          dueAt: new Date(this.d.clock.now().getTime() + 3 * 86400_000),
        });
      }
      await audit(tx, actor, { entityType: 'contact', entityId: contactId, action: 'pii_erased', newValue: { reason, ...r.counts } });
      return r.files;
    });
    for (const key of files) await this.d.adapters.storage.delete(key);
    return { erased: true, filesDeleted: files.length, providerReviewRequired: true };
  }

  private async anonymize(tx: Tx, companyId: string, contactId: string) {
    const now = this.d.clock.now();
    const leads = await tx.lead.findMany({ where: { companyId, contactId }, select: { id: true } });
    const leadIds = leads.map((l) => l.id);
    const orders = await tx.order.findMany({ where: { companyId, contactId }, select: { id: true } });
    const orderIds = orders.map((o) => o.id);
    const conversations = await tx.conversation.findMany({ where: { companyId, contactId }, select: { id: true, scopedPeerId: true } });

    await tx.contact.update({ where: { id: contactId }, data: { fullName: ERASED_NAME, primaryPhone: null, primaryEmail: null, piiErasedAt: now } });
    const ids = await tx.contactIdentifier.findMany({ where: { companyId, contactId } });
    for (const i of ids) {
      await tx.contactIdentifier.update({ where: { id: i.id }, data: { value: `erased:${hashId(`${i.type}|${i.scope}|${i.value}`)}`, originalValue: null, displayUsername: null, active: false } });
    }
    await tx.lead.updateMany({ where: { id: { in: leadIds } }, data: { name: `${ERASED_NAME} lidi`, contactOutcome: null, followUpNote: null, lostNote: null, requirements: {}, piiErasedAt: now } });
    await tx.$executeRaw`UPDATE inquiries SET form_data = NULL WHERE company_id = ${companyId}::uuid AND contact_id = ${contactId}::uuid`;
    for (const c of conversations) {
      await tx.conversation.update({ where: { id: c.id }, data: { scopedPeerId: `erased:${hashId(c.scopedPeerId)}`, peerUsername: null } });
    }
    const messages = await tx.message.updateMany({ where: { conversationId: { in: conversations.map((c) => c.id) } }, data: { content: null, attachments: [], contentPurgedAt: now } });
    await tx.passenger.updateMany({ where: { companyId, orderId: { in: orderIds } }, data: { fullName: 'O‘chirilgan yo‘lovchi', birthDate: null } });
    await tx.offer.updateMany({ where: { companyId, leadId: { in: leadIds } }, data: { note: null } });
    const files = await tx.attachment.findMany({ where: { companyId, deletedAt: null, OR: [{ ownerType: 'lead', ownerId: { in: leadIds } }, { ownerType: 'order', ownerId: { in: orderIds } }] } });
    await tx.attachment.updateMany({ where: { id: { in: files.map((f) => f.id) } }, data: { deletedAt: now, fileName: 'o‘chirilgan' } });
    return { counts: { leads: leadIds.length, orders: orderIds.length, conversations: conversations.length, messages: messages.count, files: files.length }, files: files.map((f) => f.objectKey) };
  }

  /** After a backup restore: re-apply every tombstone (idempotent). */
  async reapplyTombstones(companyId: string) {
    const tombstones = await this.d.prisma.piiTombstone.findMany({ where: { companyId } });
    let reapplied = 0;
    for (const t of tombstones) {
      const contact = await this.d.prisma.contact.findUnique({ where: { id: t.contactId } });
      if (!contact) continue;
      if (contact.fullName === ERASED_NAME && !contact.primaryPhone && contact.piiErasedAt) {
        const leftover = await this.d.prisma.contactIdentifier.count({ where: { contactId: t.contactId, active: true } });
        if (!leftover) continue;
      }
      const files = await this.d.prisma.$transaction((tx) => this.anonymize(tx, companyId, t.contactId));
      for (const key of files.files) await this.d.adapters.storage.delete(key).catch(() => undefined);
      reapplied++;
    }
    if (reapplied) await audit(this.d.prisma, systemActor(companyId, 'privacy'), { entityType: 'company', entityId: companyId, action: 'pii_tombstones_reapplied', newValue: { reapplied } });
    return { tombstones: tombstones.length, reapplied };
  }
}
