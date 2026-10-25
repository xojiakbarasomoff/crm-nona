import { createHash } from 'node:crypto';
import type { Attachment } from '@crm/database';
import { can } from '@crm/domain';
import { newObjectKey, safeFileName, signDownload, sniffMime, verifyDownload } from '@crm/integrations';
import { audit } from '../audit';
import { systemActor, type CoreDeps, type UserActor } from '../context';
import { headRecipients, notify } from '../events';
import { AppError, forbidden, notFound, unprocessable } from '../errors';
import { assertFound, canEditRecord, leadWhere, orderWhere } from '../scope';

export const ATTACHMENT_OWNER_TYPES = ['order', 'lead', 'offer', 'contact', 'passenger'] as const;
export const DOCUMENT_CATEGORIES = ['passport', 'invoice', 'payment_receipt', 'air_ticket', 'voucher', 'other'] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];
/** Pasport nusxasi uchun faqat rasm yoki PDF (ofis hujjatlari emas). */
const PASSPORT_MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
export type AttachmentOwnerType = (typeof ATTACHMENT_OWNER_TYPES)[number];

/**
 * Attachments (TZ §12.2, §21): private storage, size limit, content sniffing, malware scan before
 * any download, short-lived signed URL bound to the user, RBAC through the owning object.
 */
export class AttachmentsService {
  constructor(private readonly d: CoreDeps) {}

  /** Resolves the owner within the actor's scope; foreign owners are 404. */
  private async owner(actor: UserActor, ownerType: string, ownerId: string): Promise<{ ownerUserId: string | null }> {
    if (ownerType === 'order') {
      const o = assertFound(await this.d.prisma.order.findFirst({ where: orderWhere(actor, { id: ownerId }) }), 'Buyurtma');
      return { ownerUserId: o.ownerId };
    }
    if (ownerType === 'lead') {
      const l = assertFound(await this.d.prisma.lead.findFirst({ where: leadWhere(actor, { id: ownerId }) }), 'Lid');
      return { ownerUserId: l.ownerId };
    }
    if (ownerType === 'offer') {
      const offer = assertFound(await this.d.prisma.offer.findFirst({ where: { id: ownerId, companyId: actor.companyId } }), 'Taklif');
      const l = assertFound(await this.d.prisma.lead.findFirst({ where: leadWhere(actor, { id: offer.leadId }) }), 'Taklif');
      return { ownerUserId: l.ownerId };
    }
    if (ownerType === 'passenger') {
      const pax = assertFound(await this.d.prisma.passenger.findFirst({ where: { id: ownerId, companyId: actor.companyId } }), 'Yo‘lovchi');
      const o = assertFound(await this.d.prisma.order.findFirst({ where: orderWhere(actor, { id: pax.orderId }) }), 'Yo‘lovchi');
      return { ownerUserId: o.ownerId };
    }
    if (ownerType === 'contact') {
      // Menejer mijozni faqat o'z lidi orqali ko'radi (AdminService.getContact bilan bir xil qoida).
      const c = assertFound(await this.d.prisma.contact.findFirst({ where: { id: ownerId, companyId: actor.companyId, deletedAt: null } }), 'Mijoz');
      if (can(actor.role, 'records.view_all')) return { ownerUserId: c.ownerId };
      const mine = await this.d.prisma.lead.findFirst({ where: { companyId: actor.companyId, contactId: ownerId, ownerId: actor.id, deletedAt: null }, select: { id: true } });
      assertFound(mine, 'Mijoz');
      return { ownerUserId: actor.id };
    }
    throw notFound();
  }

  async upload(actor: UserActor, p: { ownerType: string; ownerId: string; fileName: string; declaredMime: string; data: Buffer; category?: DocumentCategory }) {
    const category: DocumentCategory = p.category ?? 'other';
    const { ownerUserId } = await this.owner(actor, p.ownerType, p.ownerId);
    if (!canEditRecord(actor, ownerUserId)) throw forbidden();
    if (!p.data.length) throw unprocessable('EMPTY_FILE', 'Fayl bo‘sh');
    if (p.data.length > this.d.config.maxUploadBytes) {
      throw new AppError(413, 'FILE_TOO_LARGE', `Fayl hajmi ${Math.round(this.d.config.maxUploadBytes / 1024 / 1024)} MB dan oshmasin`);
    }
    const sniffed = sniffMime(p.data);
    if (!sniffed) throw unprocessable('UNSUPPORTED_FILE_TYPE', 'Fayl turi ruxsat etilmagan (PDF, PNG, JPEG, WEBP, DOCX, XLSX)');
    if (p.declaredMime.split(';')[0]!.trim().toLowerCase() !== sniffed) {
      throw unprocessable('MIME_MISMATCH', 'Fayl mazmuni e’lon qilingan turga mos emas', { contentType: `sniffed:${sniffed}` });
    }
    if (category === 'passport' && !PASSPORT_MIMES.has(sniffed)) {
      throw unprocessable('UNSUPPORTED_FILE_TYPE', 'Pasport nusxasi faqat PDF yoki rasm (PNG, JPEG, WEBP) bo‘lishi mumkin', { category: 'passport_requires_image_or_pdf' });
    }
    const objectKey = newObjectKey();
    await this.d.adapters.storage.put(objectKey, p.data);
    try {
      const row = await this.d.prisma.$transaction(async (tx) => {
        const a = await tx.attachment.create({
          data: {
            companyId: actor.companyId,
            ownerType: p.ownerType,
            ownerId: p.ownerId,
            category,
            objectKey,
            fileName: safeFileName(p.fileName),
            mime: sniffed,
            size: p.data.length,
            sha256: createHash('sha256').update(p.data).digest('hex'),
            scanState: 'pending',
            uploadedById: actor.id,
          },
        });
        await audit(tx, actor, { entityType: p.ownerType, entityId: p.ownerId, action: 'attachment_uploaded', newValue: { attachmentId: a.id, category, mime: sniffed, size: a.size } });
        return a;
      });
      return serializeAttachment(row);
    } catch (err) {
      await this.d.adapters.storage.delete(objectKey).catch(() => undefined);
      throw err;
    }
  }

  async list(actor: UserActor, ownerType: string, ownerId: string, opts: { related?: boolean } = {}) {
    await this.owner(actor, ownerType, ownerId);
    if (opts.related && ownerType === 'order') return this.listForOrder(actor, ownerId);
    const rows = await this.d.prisma.attachment.findMany({ where: { companyId: actor.companyId, ownerType, ownerId, deletedAt: null }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => serializeAttachment(r));
  }

  /** Buyurtma kartasi: buyurtma, uning yo'lovchilari va mijoz hujjatlari — bitta ro'yxatda, egasi bilan. */
  private async listForOrder(actor: UserActor, orderId: string) {
    const order = assertFound(await this.d.prisma.order.findFirst({ where: orderWhere(actor, { id: orderId }) }), 'Buyurtma');
    const pax = await this.d.prisma.passenger.findMany({ where: { companyId: actor.companyId, orderId }, select: { id: true, fullName: true } });
    const contact = await this.d.prisma.contact.findFirst({ where: { id: order.contactId, companyId: actor.companyId }, select: { id: true, fullName: true } });
    const labels = new Map<string, string>([[`order:${orderId}`, `Buyurtma ${order.orderNo}`], ...pax.map((x) => [`passenger:${x.id}`, `Yo'lovchi: ${x.fullName}`] as [string, string]), ...(contact ? [[`contact:${contact.id}`, `Mijoz: ${contact.fullName ?? '—'}`] as [string, string]] : [])]);
    const rows = await this.d.prisma.attachment.findMany({
      where: {
        companyId: actor.companyId,
        deletedAt: null,
        OR: [{ ownerType: 'order', ownerId: orderId }, ...(pax.length ? [{ ownerType: 'passenger', ownerId: { in: pax.map((x) => x.id) } }] : []), ...(contact ? [{ ownerType: 'contact', ownerId: contact.id }] : [])],
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => serializeAttachment(r, labels.get(`${r.ownerType}:${r.ownerId}`)));
  }

  /** Kategoriyani o'zgartirish (noto'g'ri tanlangan bo'lsa). Passportga o'tkazishda fayl turi tekshiriladi. */
  async setCategory(actor: UserActor, id: string, category: DocumentCategory) {
    const { a, owner } = await this.loadVisible(actor, id);
    if (!canEditRecord(actor, owner.ownerUserId)) throw forbidden();
    if (category === 'passport' && !PASSPORT_MIMES.has(a.mime)) throw unprocessable('UNSUPPORTED_FILE_TYPE', 'Pasport nusxasi faqat PDF yoki rasm bo‘lishi mumkin', { category: 'passport_requires_image_or_pdf' });
    const row = await this.d.prisma.attachment.update({ where: { id }, data: { category } });
    await audit(this.d.prisma, actor, { entityType: a.ownerType, entityId: a.ownerId, action: 'attachment_recategorized', oldValue: { attachmentId: id, category: a.category }, newValue: { category } });
    return serializeAttachment(row);
  }

  private async loadVisible(actor: UserActor, id: string) {
    const a = assertFound(await this.d.prisma.attachment.findFirst({ where: { id, companyId: actor.companyId, deletedAt: null } }), 'Fayl');
    const owner = await this.owner(actor, a.ownerType, a.ownerId).catch(() => null);
    if (!owner) throw notFound('Fayl');
    return { a, owner };
  }

  /** Issues a short-lived URL bound to this user; only clean (scanned) files can be opened. */
  async downloadLink(actor: UserActor, id: string) {
    const { a } = await this.loadVisible(actor, id);
    if (a.scanState !== 'clean') {
      throw new AppError(409, a.scanState === 'infected' ? 'FILE_INFECTED' : 'FILE_NOT_SCANNED', a.scanState === 'infected' ? 'Fayl zararli deb topildi va bloklangan' : 'Fayl hali virus tekshiruvidan o‘tmagan');
    }
    const exp = Math.floor(this.d.clock.now().getTime() / 1000) + this.d.config.downloadUrlTtlSeconds;
    const sig = signDownload(this.d.config.sessionSecret, a.id, actor.id, exp);
    return { url: `/api/v1/attachments/${a.id}/content?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** Signature + live session + fresh RBAC check; a URL leaked to another user does not work. */
  async content(actor: UserActor, id: string, exp: number, sig: string) {
    if (!verifyDownload(this.d.config.sessionSecret, id, actor.id, exp, sig, Math.floor(this.d.clock.now().getTime() / 1000))) throw notFound('Fayl');
    const { a } = await this.loadVisible(actor, id);
    if (a.scanState !== 'clean') throw notFound('Fayl');
    const data = await this.d.adapters.storage.get(a.objectKey);
    await audit(this.d.prisma, actor, { entityType: a.ownerType, entityId: a.ownerId, action: 'attachment_downloaded', newValue: { attachmentId: a.id, category: a.category } });
    return { data, mime: a.mime, fileName: a.fileName };
  }

  async remove(actor: UserActor, id: string) {
    const { a, owner } = await this.loadVisible(actor, id);
    if (!canEditRecord(actor, owner.ownerUserId)) throw forbidden();
    await this.d.prisma.attachment.update({ where: { id }, data: { deletedAt: this.d.clock.now() } });
    await this.d.adapters.storage.delete(a.objectKey);
    await audit(this.d.prisma, actor, { entityType: a.ownerType, entityId: a.ownerId, action: 'attachment_deleted', oldValue: { attachmentId: a.id, category: a.category, ...(a.category === 'passport' ? {} : { fileName: a.fileName }) } });
  }

  /** Worker: scans pending files; infected files are removed from storage and quarantined. */
  async scanPending(limit = 20): Promise<number> {
    const rows = await this.d.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE attachments SET scan_state = 'pending', scanned_at = now()
      WHERE id IN (SELECT id FROM attachments WHERE scan_state = 'pending' AND deleted_at IS NULL
                   AND (scanned_at IS NULL OR scanned_at < now() - interval '5 minutes')
                   ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id`;
    for (const { id } of rows) {
      const a = await this.d.prisma.attachment.findUniqueOrThrow({ where: { id } });
      const data = await this.d.adapters.storage.get(a.objectKey).catch(() => null);
      const result = data ? await this.d.adapters.scanner.scan(data) : { verdict: 'error' as const, detail: 'object missing in storage' };
      if (result.verdict === 'error') {
        await this.d.prisma.attachment.update({ where: { id }, data: { scanDetail: result.detail.slice(0, 300) } });
        continue; // stays pending; retried after the 5-minute claim window
      }
      await this.d.prisma.attachment.update({ where: { id }, data: { scanState: result.verdict, scanDetail: result.detail.slice(0, 300), scannedAt: this.d.clock.now() } });
      if (result.verdict === 'infected') {
        await this.d.adapters.storage.delete(a.objectKey);
        await this.d.prisma.$transaction(async (tx) => {
          await audit(tx, systemActor(a.companyId, 'scanner'), { entityType: a.ownerType, entityId: a.ownerId, action: 'attachment_quarantined', newValue: { attachmentId: a.id, detail: result.detail } });
          for (const uid of new Set([a.uploadedById, ...(await headRecipients(tx, a.companyId))])) {
            await notify(tx, { companyId: a.companyId, userId: uid, kind: 'attachment_infected', dedupeKey: `att_infected:${a.id}:${uid}`, title: `Zararli fayl bloklandi: ${a.fileName}` });
          }
        });
      }
    }
    return rows.length;
  }
}

export function serializeAttachment(a: Attachment, ownerLabel?: string) {
  return { id: a.id, ownerType: a.ownerType, ownerId: a.ownerId, ownerLabel: ownerLabel ?? null, category: a.category, fileName: a.fileName, mime: a.mime, size: a.size, scanState: a.scanState, createdAt: a.createdAt, uploadedById: a.uploadedById };
}
