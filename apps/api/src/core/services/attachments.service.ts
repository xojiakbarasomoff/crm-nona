import { createHash } from 'node:crypto';
import type { Attachment } from '@crm/database';
import { newObjectKey, safeFileName, signDownload, sniffMime, verifyDownload } from '@crm/integrations';
import { audit } from '../audit';
import { systemActor, type CoreDeps, type UserActor } from '../context';
import { headRecipients, notify } from '../events';
import { AppError, forbidden, notFound, unprocessable } from '../errors';
import { assertFound, canEditRecord, leadWhere, orderWhere } from '../scope';

export const ATTACHMENT_OWNER_TYPES = ['order', 'lead', 'offer'] as const;
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
    throw notFound();
  }

  async upload(actor: UserActor, p: { ownerType: string; ownerId: string; fileName: string; declaredMime: string; data: Buffer }) {
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
    const objectKey = newObjectKey();
    await this.d.adapters.storage.put(objectKey, p.data);
    try {
      const row = await this.d.prisma.$transaction(async (tx) => {
        const a = await tx.attachment.create({
          data: {
            companyId: actor.companyId,
            ownerType: p.ownerType,
            ownerId: p.ownerId,
            objectKey,
            fileName: safeFileName(p.fileName),
            mime: sniffed,
            size: p.data.length,
            sha256: createHash('sha256').update(p.data).digest('hex'),
            scanState: 'pending',
            uploadedById: actor.id,
          },
        });
        await audit(tx, actor, { entityType: p.ownerType, entityId: p.ownerId, action: 'attachment_uploaded', newValue: { attachmentId: a.id, mime: sniffed, size: a.size } });
        return a;
      });
      return serializeAttachment(row);
    } catch (err) {
      await this.d.adapters.storage.delete(objectKey).catch(() => undefined);
      throw err;
    }
  }

  async list(actor: UserActor, ownerType: string, ownerId: string) {
    await this.owner(actor, ownerType, ownerId);
    const rows = await this.d.prisma.attachment.findMany({ where: { companyId: actor.companyId, ownerType, ownerId, deletedAt: null }, orderBy: { createdAt: 'desc' } });
    return rows.map(serializeAttachment);
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
    await audit(this.d.prisma, actor, { entityType: a.ownerType, entityId: a.ownerId, action: 'attachment_downloaded', newValue: { attachmentId: a.id } });
    return { data, mime: a.mime, fileName: a.fileName };
  }

  async remove(actor: UserActor, id: string) {
    const { a, owner } = await this.loadVisible(actor, id);
    if (!canEditRecord(actor, owner.ownerUserId)) throw forbidden();
    await this.d.prisma.attachment.update({ where: { id }, data: { deletedAt: this.d.clock.now() } });
    await this.d.adapters.storage.delete(a.objectKey);
    await audit(this.d.prisma, actor, { entityType: a.ownerType, entityId: a.ownerId, action: 'attachment_deleted', oldValue: { attachmentId: a.id, fileName: a.fileName } });
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

export function serializeAttachment(a: Attachment) {
  return { id: a.id, ownerType: a.ownerType, ownerId: a.ownerId, fileName: a.fileName, mime: a.mime, size: a.size, scanState: a.scanState, createdAt: a.createdAt, uploadedById: a.uploadedById };
}
