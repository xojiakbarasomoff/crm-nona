import type { Channel, IntegrationConnection, Lead, Prisma, Tx } from '@crm/database';
import { decryptSecret } from '@crm/database';
import { decideOutbound, normalizeEmail, normalizePhone, type CompanyPhoneRule } from '@crm/domain';
import type { ChatsOutgoingReply, IgMessageEvent, IgReadEvent, LeadgenEvent, MetaLeadData } from '@crm/integrations';
import { audit } from '../audit';
import { integrationActor, type CoreDeps } from '../context';
import { headRecipients, notify, publishEvent } from '../events';
import { enqueueOutbox } from '../queue';
import { identifyContact } from './identity.service';
import { IG_PLACEHOLDER_NAME, InstagramProfileService } from './instagram-profile.service';
import { LeadsService } from './leads.service';
import { markLiveVerified, SENDABLE_DEGRADED_REASONS } from './live-verification';

export class ConnectionPausedError extends Error {
  constructor(readonly connectionId: string) {
    super('Integration connection is paused or disconnected');
  }
}

export interface LeadFormMapping {
  /** provider field name → local field */
  fields?: Record<string, 'full_name' | 'phone' | 'email' | 'destination' | 'service_type' | 'note'>;
  /** Confirmed by the business: this form is used only on Instagram placements. */
  instagramOnly?: boolean;
  serviceType?: string;
  version?: number;
}

const DEFAULT_FIELD_MAP: NonNullable<LeadFormMapping['fields']> = {
  full_name: 'full_name',
  phone_number: 'phone',
  email: 'email',
  destination: 'destination',
};

export const UNSUPPORTED_MEDIA_TEXT = 'Ushbu xabar turini Instagram’da oching';

export function connectionToken(conn: IntegrationConnection, key: Buffer): string {
  if (!conn.credentialsEnc) return '';
  const creds = JSON.parse(decryptSecret(conn.credentialsEnc, key)) as { accessToken?: string };
  return creds.accessToken ?? '';
}

export function assertConnectionActive(conn: IntegrationConnection) {
  if (conn.disconnectedAt || conn.health === 'paused' || conn.health === 'disconnected') throw new ConnectionPausedError(conn.id);
}

/** Determines channel and placement only from explicit evidence (TZ §8.1). */
export function leadAdsChannel(lead: MetaLeadData, mapping: LeadFormMapping | undefined): { channel: Channel; placement: string } {
  const p = lead.platform?.toLowerCase() ?? null;
  if (p === 'ig' || p === 'instagram') return { channel: 'instagram_lead_ads', placement: 'instagram' };
  if (p === 'fb' || p === 'facebook') return { channel: 'meta_lead_ads', placement: 'facebook' };
  if (mapping?.instagramOnly) return { channel: 'instagram_lead_ads', placement: 'instagram_form_mapping' };
  return { channel: 'meta_lead_ads', placement: 'unknown' };
}

type PendingAssignment = { lead: Lead; args: Parameters<LeadsService['assignLead']>[2] };

/** Intake transactions: generous timeout, bounded lock waits (fail fast and retry via inbox). */
export const INTAKE_TX = { timeout: 20_000, maxWait: 10_000 } as const;

export class IntakeService {
  private readonly leads: LeadsService;
  /** Leads created in a transaction that still need round-robin assignment before commit. */
  private readonly pending = new WeakMap<object, PendingAssignment[]>();

  private async begin(tx: Tx) {
    await tx.$executeRaw`SET LOCAL lock_timeout = '15s'`;
    this.pending.set(tx, []);
  }

  /** Takes the manager-pool lock as the final step, so it is held only until commit. */
  private async finishAssignments(tx: Tx) {
    for (const a of this.pending.get(tx) ?? []) await this.leads.assignLead(tx, a.lead, a.args);
    this.pending.delete(tx);
  }
  private readonly profiles: InstagramProfileService;
  constructor(private readonly d: CoreDeps) {
    this.leads = new LeadsService(d);
    this.profiles = new InstagramProfileService(d);
  }

  private async connection(provider: 'META_LEADS' | 'META_DIRECT' | 'AMOCRM_CHATS', accountId: string) {
    return this.d.prisma.integrationConnection.findFirst({ where: { provider, accountId } });
  }

  // ---------------- Lead Ads (TZ §8) ----------------

  async processLeadgen(evt: LeadgenEvent, receivedAt: Date, correlationId: string): Promise<'processed' | 'duplicate' | 'ignored'> {
    const conn = await this.connection('META_LEADS', evt.pageId);
    if (!conn) return 'ignored';
    assertConnectionActive(conn);
    const companyId = conn.companyId;
    const eventKey = `meta_leads:${evt.leadgenId}`;
    const done = await this.d.prisma.inquiry.findUnique({ where: { companyId_providerEventKey: { companyId, providerEventKey: eventKey } } });
    if (done?.processedAt) return 'duplicate';

    // Fetch outside the transaction; webhook payloads never carry the answers reliably.
    const lead = await this.d.adapters.metaLeads.fetchLead(evt.leadgenId, connectionToken(conn, this.d.encryptionKey));
    const company = await this.d.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const settings = (company.settings ?? {}) as { leadForms?: Record<string, LeadFormMapping> };
    const mapping = lead.formId ? settings.leadForms?.[lead.formId] : undefined;
    const fieldMap = { ...DEFAULT_FIELD_MAP, ...(mapping?.fields ?? {}) };
    const local: Record<string, string> = {};
    for (const [providerField, value] of Object.entries(lead.fields)) {
      const target = fieldMap[providerField];
      if (target) local[target] = value;
    }
    const nullReasons: Record<string, string> = {};
    if (!local.full_name) nullReasons.full_name = 'not_in_form_response';
    if (!local.phone) nullReasons.phone = 'not_in_form_response';
    const phone = normalizePhone(local.phone ?? null, company.phoneRule as CompanyPhoneRule | null);
    if (local.phone && phone.status !== 'ok') nullReasons.phone_normalized = phone.status;
    const email = normalizeEmail(local.email ?? null);
    const { channel, placement } = leadAdsChannel(lead, mapping);
    const actor = integrationActor(companyId, 'meta_lead_ads');

    const result = await this.d.prisma.$transaction(async (tx) => {
      await this.begin(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`inquiry:${companyId}:${eventKey}`}, 0))`;
      const existing = await tx.inquiry.findUnique({ where: { companyId_providerEventKey: { companyId, providerEventKey: eventKey } } });
      if (existing?.processedAt) return 'duplicate' as const;
      const inquiry =
        existing ??
        (await tx.inquiry.create({
          data: {
            companyId,
            providerEventKey: eventKey,
            channel,
            placement,
            sourceCreatedAt: lead.createdTime ?? evt.createdTime,
            receivedAt,
            attribution: { leadgenId: evt.leadgenId, formId: lead.formId ?? evt.formId, pageId: evt.pageId, adId: lead.adId ?? evt.adId, adsetId: lead.adsetId ?? evt.adgroupId, campaignId: lead.campaignId, platform: lead.platform },
            formData: lead.fields,
            nullReasons,
            mappingVersion: mapping?.version ?? 0,
            correlationId,
            processingState: 'processing',
          },
        }));

      const identity = await identifyContact(tx, {
        companyId,
        identifiers: [
          ...(phone.status === 'ok' ? [{ type: 'phone' as const, value: phone.normalized, scope: '', verified: true, originalValue: phone.original }] : []),
          ...(email ? [{ type: 'email' as const, value: email, scope: '', verified: true }] : []),
        ],
        fullName: local.full_name ?? null,
        primaryPhone: phone.status === 'ok' ? phone.normalized : null,
        primaryEmail: email,
      });

      const linked = await this.attachOrCreateLead(tx, {
        companyId,
        contactId: identity.contactId,
        inquiryId: inquiry.id,
        channel,
        placement,
        name: `${local.full_name ?? 'Lead Ads'} — ${local.destination ?? 'so‘rov'}`,
        serviceType: (local.service_type ?? mapping?.serviceType ?? null) as string | null,
        at: receivedAt,
        actor,
      });

      const adId = lead.adId ?? evt.adId;
      await tx.inquiry.update({
        where: { id: inquiry.id },
        data: {
          contactId: identity.contactId,
          leadId: linked.lead?.id ?? null,
          processedAt: this.d.clock.now(),
          processingState: linked.lead ? 'linked' : 'needs_lead_selection',
          enrichmentState: adId ? 'pending' : 'not_available',
        },
      });
      if (adId) {
        await enqueueOutbox(tx, { companyId, operationKey: `inquiry.enrich:${inquiry.id}`, target: 'meta', action: 'meta.enrich', payload: { inquiryId: inquiry.id, adId, connectionId: conn.id } });
      }
      await audit(tx, actor, { entityType: 'inquiry', entityId: inquiry.id, action: 'lead_ads_processed', newValue: { contactId: identity.contactId, leadId: linked.lead?.id ?? null, createdLead: linked.created, channel, placement } });
      await this.finishAssignments(tx);
      return 'processed' as const;
    }, INTAKE_TX);
    return result;
  }

  /**
   * Repeat inquiry rules (TZ §7.3): one active lead → attach; several → manager chooses; none → new
   * lead (a closed lead is never reopened automatically).
   */
  private async attachOrCreateLead(
    tx: Tx,
    p: { companyId: string; contactId: string; inquiryId: string; channel: Channel; placement: string; name: string; serviceType: string | null; at: Date; actor: ReturnType<typeof integrationActor>; preferredLeadId?: string | null },
  ): Promise<{ lead: Lead | null; created: boolean }> {
    // New leads are assigned by the caller right before commit (see finishAssignments).
    const active = await this.leads.findActiveLeads(tx, p.companyId, p.contactId);
    if (p.preferredLeadId) {
      const preferred = active.find((l) => l.id === p.preferredLeadId);
      if (preferred) return { lead: preferred, created: false };
    }
    if (active.length === 1) return { lead: active[0]!, created: false };
    if (active.length > 1) {
      const owner = active[0]!.ownerId;
      if (owner) await notify(tx, { companyId: p.companyId, userId: owner, kind: 'inquiry_needs_lead', dedupeKey: `inquiry_needs_lead:${p.inquiryId}`, title: 'Yangi murojaat: qaysi safarga tegishli ekanini tanlang', link: `/contacts/${p.contactId}` });
      return { lead: null, created: false };
    }
    const lead = await this.leads.createLead(tx, { companyId: p.companyId, contactId: p.contactId, name: p.name, channel: p.channel, placement: p.placement, inquiryId: p.inquiryId, serviceType: p.serviceType, at: p.at, actor: p.actor, deferAssignment: true });
    this.pending.get(tx)?.push({ lead, args: { companyId: p.companyId, contactId: p.contactId, name: p.name, serviceType: p.serviceType, at: p.at, actor: p.actor } });
    return { lead, created: true };
  }

  // ---------------- Direct inbound (TZ §9) ----------------

  async processIgMessage(evt: IgMessageEvent, receivedAt: Date, correlationId: string): Promise<'processed' | 'duplicate' | 'ignored' | 'echo'> {
    const conn = await this.connection('META_DIRECT', evt.businessAccountId);
    if (!conn) return 'ignored';
    assertConnectionActive(conn);
    if (evt.isEcho) return this.processEcho(conn, evt);
    const companyId = conn.companyId;
    const actor = integrationActor(companyId, 'instagram_direct');

    // Yangi suhbat bo'lsa, mijoz profilini (username/name) tranzaksiyadan TASHQARIDA, qisqa timeout bilan olamiz: xato bo'lsa xabar va lid
    // baribir yaratiladi («Instagram foydalanuvchisi»), username keyin nazoratli qayta urinish bilan to'ldiriladi.
    const hadConversation = !!(await this.d.prisma.conversation.findUnique({ where: { connectionId_scopedPeerId: { connectionId: conn.id, scopedPeerId: evt.scopedPeerId } }, select: { id: true } }));
    const fetched = hadConversation ? null : await this.profiles.fetchBestEffort(conn, evt.scopedPeerId);
    const fetchedUsername = fetched?.profile?.username ?? null;

    const out = await this.d.prisma.$transaction(async (tx) => {
      await this.begin(tx);
      if (evt.mid) {
        const dup = await tx.message.findUnique({ where: { connectionId_providerMessageId: { connectionId: conn.id, providerMessageId: evt.mid } } });
        if (dup) return { state: 'duplicate' as const };
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`conv:${conn.id}:${evt.scopedPeerId}`}, 0))`;
      let conversation = await tx.conversation.findUnique({ where: { connectionId_scopedPeerId: { connectionId: conn.id, scopedPeerId: evt.scopedPeerId } } });
      let leadId = conversation?.leadId ?? null;

      const leadTitle = async (contactId: string) => {
        const c = await tx.contact.findUnique({ where: { id: contactId }, select: { instagramUsername: true } });
        const u = c?.instagramUsername ?? fetchedUsername;
        return u ? `@${u}` : IG_PLACEHOLDER_NAME;
      };
      const needsLead = async (contactId: string, preferredLeadId: string | null) => {
        const inquiry = await tx.inquiry.create({
          data: {
            companyId,
            providerEventKey: `ig_inquiry:${conn.id}:${evt.mid || evt.key}`,
            contactId,
            channel: 'instagram_direct',
            placement: 'instagram',
            sourceCreatedAt: evt.timestamp,
            receivedAt,
            attribution: evt.referral ? { referral: evt.referral } : {},
            correlationId,
            processingState: 'processing',
          },
        });
        const linked = await this.attachOrCreateLead(tx, {
          companyId,
          contactId,
          inquiryId: inquiry.id,
          channel: 'instagram_direct',
          placement: 'instagram',
          name: await leadTitle(contactId),
          serviceType: null,
          at: receivedAt,
          actor,
          preferredLeadId,
        });
        await tx.inquiry.update({ where: { id: inquiry.id }, data: { leadId: linked.lead?.id ?? null, processedAt: this.d.clock.now(), processingState: linked.lead ? 'linked' : 'needs_lead_selection' } });
        return linked.lead?.id ?? null;
      };

      if (!conversation) {
        const identity = await identifyContact(tx, {
          companyId,
          identifiers: [{ type: 'instagram_scoped', value: evt.scopedPeerId, scope: evt.businessAccountId, verified: true, displayUsername: fetchedUsername }],
          fullName: null,
          primaryPhone: null,
          primaryEmail: null,
        });
        if (conn.mode === 'live') {
          // Profil maydonlari kontaktda alohida; mijoz aniqlash bunga emas, scoped ID'ga tayanadi (identifyContact yuqorida).
          const now = this.d.clock.now();
          const known = await tx.contact.findUnique({ where: { id: identity.contactId }, select: { instagramUsername: true } });
          if (!known?.instagramUsername) {
            await tx.contact.update({
              where: { id: identity.contactId },
              data: fetchedUsername
                ? { instagramUsername: fetchedUsername, instagramName: fetched?.profile?.name ?? null, instagramProfileFetchedAt: now, instagramProfileAttempts: 0, instagramProfileNextAttemptAt: null, instagramProfileError: null }
                : { instagramProfileAttempts: 1, instagramProfileNextAttemptAt: new Date(now.getTime() + 60_000), instagramProfileError: (fetched?.error ?? 'unknown').slice(0, 120) },
            });
          }
        }
        leadId = await needsLead(identity.contactId, null);
        conversation = await tx.conversation.create({
          data: { companyId, connectionId: conn.id, businessAccountId: evt.businessAccountId, scopedPeerId: evt.scopedPeerId, peerUsername: fetchedUsername, contactId: identity.contactId, leadId, historyAvailableFrom: evt.timestamp },
        });
      } else {
        const current = leadId ? await tx.lead.findUnique({ where: { id: leadId } }) : null;
        const closed = !current || current.deletedAt || current.stage === 'WON' || current.stage === 'LOST';
        if (closed) {
          const travelling = current?.stage === 'WON'
            ? await tx.order.findFirst({ where: { companyId, leadId: current.id, fulfillmentState: { in: ['confirmed', 'in_progress'] } } })
            : null;
          if (!travelling) {
            leadId = await needsLead(conversation.contactId, null);
            await tx.conversation.update({ where: { id: conversation.id }, data: { leadId } });
          }
        }
      }

      const text = evt.isUnsupported ? UNSUPPORTED_MEDIA_TEXT : evt.text;
      const message = await tx.message.create({
        data: {
          companyId,
          conversationId: conversation.id,
          connectionId: conn.id,
          providerMessageId: evt.mid || null,
          direction: 'inbound',
          type: evt.isUnsupported ? 'unsupported' : evt.attachments.length ? evt.attachments[0]!.type : 'text',
          content: text,
          attachments: evt.attachments.map((a) => ({ type: a.type, providerUrlTransient: !!a.url })) as Prisma.InputJsonValue,
          state: 'received',
          actorType: 'customer',
          providerAt: evt.timestamp,
        },
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastInboundAt: evt.timestamp, ...(conversation.firstInboundAt ? {} : { firstInboundAt: evt.timestamp }) },
      });
      if (this.d.adapters.amoChats) {
        await enqueueOutbox(tx, { companyId, operationKey: `chat.import:${message.id}`, target: 'amocrm_chats', action: 'chat.import', payload: { messageId: message.id } });
      }
      await this.finishAssignments(tx);
      return { state: 'processed' as const, conversationId: conversation.id, ownerLeadId: leadId };
    }, INTAKE_TX);
    if (out.state === 'processed') {
      await publishEvent(this.d.redis, { companyId, entityType: 'conversation', entityId: out.conversationId, kind: 'message' });
      if (conn.mode === 'live') await markLiveVerified(this.d.prisma, conn.id, 'inbound', this.d.clock.now());
    }
    return out.state;
  }

  /**
   * Echo suppression (TZ §4.3): an echo of our own outbound message updates that message; an echo
   * of a message typed natively in Instagram is stored as a human outbound message. Neither is ever
   * forwarded as a new customer message.
   */
  private async processEcho(conn: IntegrationConnection, evt: IgMessageEvent): Promise<'echo'> {
    await this.d.prisma.$transaction(async (tx) => {
      const own = evt.mid ? await tx.message.findUnique({ where: { connectionId_providerMessageId: { connectionId: conn.id, providerMessageId: evt.mid } } }) : null;
      if (own) {
        if (['queued', 'sending', 'unknown'].includes(own.state)) await tx.message.update({ where: { id: own.id }, data: { state: 'accepted', isEcho: true } });
        return;
      }
      const conversation = await tx.conversation.findUnique({ where: { connectionId_scopedPeerId: { connectionId: conn.id, scopedPeerId: evt.scopedPeerId } } });
      if (!conversation) return;
      const pending = await tx.message.findFirst({
        where: { conversationId: conversation.id, direction: 'outbound', state: { in: ['unknown', 'sending'] }, providerMessageId: null, content: evt.text, createdAt: { gte: new Date(evt.timestamp.getTime() - 15 * 60_000) } },
        orderBy: { createdAt: 'desc' },
      });
      if (pending) {
        await tx.message.update({ where: { id: pending.id }, data: { providerMessageId: evt.mid || null, state: 'accepted', isEcho: true } });
        await tx.outboxOperation.updateMany({ where: { companyId: conn.companyId, operationKey: `direct.send:${pending.operationId}`, state: 'unknown' }, data: { state: 'done', result: { reconciledBy: 'echo' } } });
        return;
      }
      await tx.message.create({
        data: {
          companyId: conn.companyId,
          conversationId: conversation.id,
          connectionId: conn.id,
          providerMessageId: evt.mid || null,
          direction: 'outbound',
          type: 'text',
          content: evt.text,
          state: 'accepted',
          actorType: 'human',
          isEcho: true,
          providerAt: evt.timestamp,
        },
      });
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastHumanReplyAt: evt.timestamp, ...(conversation.firstHumanReplyAt ? {} : { firstHumanReplyAt: evt.timestamp }) } });
    });
    return 'echo';
  }

  async processIgRead(evt: IgReadEvent): Promise<'processed' | 'ignored'> {
    const conn = await this.connection('META_DIRECT', evt.businessAccountId);
    if (!conn || !evt.mid) return 'ignored';
    const res = await this.d.prisma.message.updateMany({
      where: { connectionId: conn.id, providerMessageId: evt.mid, direction: 'outbound', state: { in: ['accepted', 'delivered'] } },
      data: { state: 'read' },
    });
    return res.count ? 'processed' : 'ignored';
  }

  // ---------------- Reply typed in amoCRM (TZ §9.2) ----------------

  async processChatReply(reply: ChatsOutgoingReply, connectionKey: string): Promise<'queued' | 'blocked' | 'duplicate' | 'ignored'> {
    const chatConn = await this.d.prisma.integrationConnection.findFirst({ where: { provider: 'AMOCRM_CHATS', routeToken: connectionKey } });
    if (!chatConn) return 'ignored';
    const companyId = chatConn.companyId;
    const conversation = await this.d.prisma.conversation.findFirst({ where: { id: reply.conversationId, companyId } });
    if (!conversation) return 'ignored';
    const directConn = await this.d.prisma.integrationConnection.findFirstOrThrow({ where: { id: conversation.connectionId } });
    const operationKey = `direct.send:${reply.amoMessageId}`;

    return this.d.prisma.$transaction(async (tx) => {
      const dup = await tx.message.findFirst({ where: { companyId, amoMessageId: reply.amoMessageId } });
      if (dup) return 'duplicate' as const;
      const author = reply.authorAmoUserId ? await tx.user.findFirst({ where: { companyId, amoUserId: reply.authorAmoUserId, status: 'active' } }) : null;
      const lead = conversation.leadId ? await tx.lead.findUnique({ where: { id: conversation.leadId } }) : null;
      const senderMayReply = !!author && (author.role !== 'MANAGER' || lead?.ownerId === author.id);
      const decision = decideOutbound(
        {
          now: this.d.clock.now(),
          lastCustomerMessageAt: conversation.lastInboundAt,
          purpose: 'human_reply',
          // Haqiqiy sinovdan oldingi (awaiting_live_verification) ulanishdan ham javob yuborishga urinish mumkin, aks holda chiquvchi sinov o'tolmaydi.
          connectionHealthy: !directConn.disconnectedAt && (directConn.health === 'ok' || (directConn.health === 'degraded' && !!directConn.healthReason && SENDABLE_DEGRADED_REASONS.includes(directConn.healthReason))),
          senderMayReply,
          recipientScopedIdVerified: reply.receiverId === conversation.scopedPeerId,
        },
        { standardWindowHours: this.d.config.meta.standardWindowHours, humanAgentWindowHours: this.d.config.meta.humanAgentWindowHours, humanAgentPermissionGranted: this.d.config.meta.humanAgentGranted },
      );
      const message = await tx.message.create({
        data: {
          companyId,
          conversationId: conversation.id,
          connectionId: conversation.connectionId,
          direction: 'outbound',
          type: 'text',
          content: reply.text,
          state: decision.allowed ? 'queued' : 'failed',
          actorType: 'human',
          actorUserId: author?.id ?? null,
          amoMessageId: reply.amoMessageId,
          operationId: reply.amoMessageId,
          error: decision.allowed ? null : decision.reason,
        },
      });
      const actor = integrationActor(companyId, 'amocrm_chat');
      if (!decision.allowed) {
        await enqueueOutbox(tx, { companyId, operationKey: `chat.status:${message.id}:failed`, target: 'amocrm_chats', action: 'chat.status', payload: { messageId: message.id, status: 'failed', error: decision.message } });
        if (author) await notify(tx, { companyId, userId: author.id, kind: 'direct_blocked', dedupeKey: `direct_blocked:${message.id}`, title: 'Instagram xabari yuborilmadi', body: decision.message, link: lead ? `/leads/${lead.id}` : null });
        await audit(tx, actor, { entityType: 'message', entityId: message.id, action: 'outbound_blocked', newValue: { reason: decision.reason } });
        return 'blocked' as const;
      }
      await enqueueOutbox(tx, { companyId, operationKey, target: 'meta', action: 'meta.send', payload: { messageId: message.id, tag: decision.tag } });
      return 'queued' as const;
    });
  }

  async notifyHeads(tx: Tx, companyId: string, kind: string, title: string, key: string) {
    for (const uid of await headRecipients(tx, companyId)) await notify(tx, { companyId, userId: uid, kind, dedupeKey: `${key}:${uid}`, title });
  }
}
