import type { Prisma } from '@crm/database';
import { can, normalizePhone, type CompanyPhoneRule } from '@crm/domain';
import { audit } from '../audit';
import type { CoreDeps, UserActor } from '../context';
import { notify } from '../events';
import { AppError, forbidden, unprocessable } from '../errors';
import { assertFound, canEditRecord, leadWhere } from '../scope';
import { LeadsService } from './leads.service';

export interface ManualLeadInput {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  telegram?: string | null;
  instagram?: string | null;
  /** Lid sarlavhasi (ixtiyoriy). */
  name?: string | null;
  ownerId?: string | null;
  note?: string | null;
  /** Foydalanuvchi mavjud kontaktni tanladi (avtomatik birlashtirilmaydi, lid shu kontaktga ochiladi). */
  existingContactId?: string | null;
  /** Telefon boshqa kontaktda bo'lsa ham yangi kontakt yaratish (identifikator «umumiy» deb belgilanadi va dublikat tekshiruviga tushadi). */
  forceNewContact?: boolean;
  leadType?: 'NEW' | 'REFERRAL' | 'REPEAT';
}

export interface ContactEditInput {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  telegram?: string | null;
  instagram?: string | null;
  /** Telefon boshqa kontaktda bo'lsa ham saqlash (umumiy deb belgilanadi, dublikat tekshiruviga tushadi; birlashtirilmaydi). */
  allowDuplicatePhone?: boolean;
}

const clean = (v: string | null | undefined) => {
  const t = (v ?? '').trim().replace(/\s+/g, ' ');
  return t ? t : null;
};

/** Telegram username: «@name», «name» yoki t.me havolasi; 5–32 belgi, harf bilan boshlanadi. */
export function normalizeTelegram(raw: string | null | undefined): string | null | 'invalid' {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const v = t.replace(/^https?:\/\/(?:www\.)?(?:t|telegram)\.me\//i, '').replace(/^@+/, '').replace(/[/?#].*$/, '');
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v) ? v : 'invalid';
}

/** Instagram username: «@name», «name» или ссылка instagram.com/name; 1–30 символов (буквы, цифры, «.», «_»). */
export function normalizeInstagram(raw: string | null | undefined): string | null | 'invalid' {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const v = t.replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '').replace(/^@+/, '').replace(/[/?#].*$/, '').toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(v) ? v : 'invalid';
}
const IG_INVALID = 'Неверный Instagram username (до 30 символов: буквы, цифры, «.», «_»)';

const fullNameOf = (first: string | null, last: string | null) => [first, last].filter(Boolean).join(' ') || null;

/**
 * Qo'lda lid yaratish va mijoz ma'lumotlarini tahrirlash. Mavjud tayinlash qoidalari (LeadsService.assignLead) ishlatiladi;
 * Instagram identifikatorlari, biznes akkaunt va yozishmalar bog'lanishiga TEGILMAYDI. Telefon dublikati avtomatik birlashtirilmaydi.
 */
export class ManualLeadService {
  private readonly leads: LeadsService;
  constructor(private readonly d: CoreDeps) {
    this.leads = new LeadsService(d);
  }

  private async phoneRule(companyId: string) {
    const company = await this.d.prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { phoneRule: true } });
    return company.phoneRule as unknown as CompanyPhoneRule | null;
  }

  private async parsePhone(companyId: string, raw: string | null | undefined) {
    const t = clean(raw);
    if (!t) return null;
    const r = normalizePhone(t, await this.phoneRule(companyId));
    if (r.status === 'ok') return { normalized: r.normalized, original: r.original };
    throw unprocessable('PHONE_INVALID', r.status === 'needs_review' ? 'Введите номер телефона с кодом страны (например, +998901234567)' : 'Неверный номер телефона', { phone: r.status === 'needs_review' ? 'needs_country_code' : 'invalid' });
  }

  /** Telefon boshqa faol kontaktlarda bormi (shu kontaktning o'zi hisobga olinmaydi). Menejerga faqat o'zining yoki egasiz kontaktlari ko'rsatiladi. */
  private async phoneHolders(actor: UserActor, phone: string, exceptContactId: string | null) {
    const rows = await this.d.prisma.contactIdentifier.findMany({
      where: { companyId: actor.companyId, type: 'phone', value: phone, active: true, ...(exceptContactId ? { contactId: { not: exceptContactId } } : {}), contact: { deletedAt: null, mergedIntoId: null, piiErasedAt: null } },
      select: { contactId: true, contact: { select: { id: true, fullName: true, instagramUsername: true, telegramUsername: true, ownerId: true } } },
    });
    const seen = new Map<string, (typeof rows)[number]['contact']>();
    for (const r of rows) seen.set(r.contactId, r.contact);
    const all = [...seen.values()];
    const visible = can(actor.role, 'records.view_all') ? all : all.filter((c) => c.ownerId === actor.id || c.ownerId === null);
    const counts = await this.d.prisma.lead.groupBy({ by: ['contactId'], where: { companyId: actor.companyId, contactId: { in: visible.map((c) => c.id) }, deletedAt: null }, _count: { _all: true } });
    const n = new Map(counts.map((c) => [c.contactId, c._count._all]));
    return { total: all.length, visible: visible.map((c) => ({ id: c.id, name: c.fullName, instagramUsername: c.instagramUsername, telegramUsername: c.telegramUsername, leads: n.get(c.id) ?? 0 })) };
  }

  private phoneConflict(h: { total: number; visible: unknown[] }) {
    return new AppError(409, 'PHONE_EXISTS', 'Этот номер телефона уже есть у другого контакта. Выберите существующий контакт или создайте новый.', undefined, { candidates: h.visible, hiddenCount: h.total - h.visible.length });
  }

  async create(actor: UserActor, input: ManualLeadInput) {
    const first = clean(input.firstName);
    const last = clean(input.lastName);
    const tg = normalizeTelegram(input.telegram);
    if (tg === 'invalid') throw unprocessable('TELEGRAM_INVALID', 'Неверный Telegram username (5–32 символа: буквы, цифры, подчёркивание)', { telegram: 'invalid' });
    const ig = normalizeInstagram(input.instagram);
    if (ig === 'invalid') throw unprocessable('INSTAGRAM_INVALID', IG_INVALID, { instagram: 'invalid' });
    if (!input.existingContactId && !first && !last) throw unprocessable('NAME_REQUIRED', 'Укажите хотя бы имя или фамилию', { firstName: 'required', lastName: 'required' });
    const phone = input.existingContactId ? null : await this.parsePhone(actor.companyId, input.phone);
    const note = clean(input.note);
    const leadTitle = clean(input.name);

    // Ответственный: менеджер и пользователь — всегда сам автор (по сессии); администратор — выбранный сотрудник или правила распределения.
    let explicitOwner: string | null = null;
    if (!can(actor.role, 'leads.reassign')) {
      if (input.ownerId && input.ownerId !== actor.id) throw forbidden('Лид можно назначить только себе');
      explicitOwner = actor.id;
    } else if (input.ownerId) {
      const u = await this.d.prisma.user.findFirst({ where: { id: input.ownerId, companyId: actor.companyId, status: 'active' }, select: { id: true } });
      if (!u) throw unprocessable('ASSIGNEE_INVALID', 'Выбранный сотрудник неактивен', { ownerId: 'invalid' });
      explicitOwner = u.id;
    }

    // Telefon dublikati: avtomatik birlashtirilmaydi — foydalanuvchi tanlaydi.
    if (phone && !input.existingContactId && !input.forceNewContact) {
      const h = await this.phoneHolders(actor, phone.normalized, null);
      if (h.total > 0) throw this.phoneConflict(h);
    }

    const now = this.d.clock.now();
    return this.d.prisma.$transaction(async (tx) => {
      let contactId: string;
      let createdContact = false;
      if (input.existingContactId) {
        const c = assertFound(await tx.contact.findFirst({ where: { id: input.existingContactId, companyId: actor.companyId, deletedAt: null, mergedIntoId: null, piiErasedAt: null } }), 'Контакт');
        if (!can(actor.role, 'records.view_all') && c.ownerId !== null && c.ownerId !== actor.id) throw forbidden();
        contactId = c.id;
      } else {
        const c = await tx.contact.create({
          data: { companyId: actor.companyId, fullName: fullNameOf(first, last), firstName: first, lastName: last, primaryPhone: phone?.normalized ?? null, telegramUsername: tg, instagramUsername: ig, syncState: 'pending_create' },
        });
        contactId = c.id;
        createdContact = true;
        if (phone) {
          const holders = input.forceNewContact ? await tx.contactIdentifier.count({ where: { companyId: actor.companyId, type: 'phone', value: phone.normalized, active: true, contactId: { not: c.id } } }) : 0;
          await tx.contactIdentifier.create({ data: { companyId: actor.companyId, contactId: c.id, type: 'phone', value: phone.normalized, scope: '', verified: true, shared: holders > 0, originalValue: phone.original } });
          if (holders > 0) {
            const others = await tx.contactIdentifier.findMany({ where: { companyId: actor.companyId, type: 'phone', value: phone.normalized, active: true, contactId: { not: c.id } }, select: { contactId: true } });
            await tx.duplicateCandidate.create({ data: { companyId: actor.companyId, contactIds: [...new Set([c.id, ...others.map((o) => o.contactId)])], reason: 'shared_identifier', identifier: { type: 'phone', scope: '', value: phone.normalized } } });
          }
        }
        await audit(tx, actor, { entityType: 'contact', entityId: c.id, action: 'manual_created', newValue: { firstName: first, lastName: last, hasPhone: !!phone, telegram: tg } });
      }

      const existingContact = input.existingContactId ? await tx.contact.findUniqueOrThrow({ where: { id: contactId } }) : null;
      const title = leadTitle ?? (existingContact ? existingContact.fullName ?? (existingContact.instagramUsername ? `@${existingContact.instagramUsername}` : 'Новый лид') : fullNameOf(first, last) ?? 'Новый лид');
      // createLead(deferAssignment) — mas'ul pastda: tayinlash qoidalari tranzaksiyaning OXIRGI qadami bo'lishi kerak.
      const lead = await this.leads.createLead(tx, { companyId: actor.companyId, contactId, name: title, channel: 'manual', placement: 'manual', inquiryId: null, serviceType: null, at: now, actor, deferAssignment: true, note });
      if (input.leadType) await tx.lead.update({ where: { id: lead.id }, data: { leadType: input.leadType } });
      let result;
      if (explicitOwner) {
        result = await tx.lead.update({ where: { id: lead.id }, data: { ownerId: explicitOwner, assignmentReason: 'manual_selection' } });
        await tx.contact.updateMany({ where: { id: contactId, ownerId: null }, data: { ownerId: explicitOwner } });
        await tx.leadEvent.create({ data: { companyId: actor.companyId, leadId: lead.id, kind: 'created', newStage: 'NEW', newOwnerId: explicitOwner, reason: 'manual_selection', origin: 'local', algorithmVersion: 'manual', effectiveAt: now } });
        await audit(tx, actor, { entityType: 'lead', entityId: lead.id, action: 'assigned', newValue: { ownerId: explicitOwner, reason: 'manual_selection' } });
        if (explicitOwner !== actor.id) await notify(tx, { companyId: actor.companyId, userId: explicitOwner, kind: 'lead_assigned', dedupeKey: `lead_assigned:${lead.id}:${explicitOwner}`, title: `Новый лид: ${title}`, link: `/leads/${lead.id}` });
        await this.leads.createCrmTask(tx, { companyId: actor.companyId, key: `${lead.id}:first_contact:created`, entityId: lead.id, kind: 'first_contact', text: `Первый контакт: ${title}`, responsibleUserId: explicitOwner, dueAt: result.firstResponseDueAt ?? new Date(now.getTime() + 15 * 60_000) });
      } else {
        result = await this.leads.assignLead(tx, lead, { companyId: actor.companyId, contactId, name: title, serviceType: null, at: now, actor });
      }
      await audit(tx, actor, { entityType: 'lead', entityId: lead.id, action: 'manual_created', newValue: { contactId, newContact: createdContact, source: 'manual' } });
      return result;
    });
  }

  /** Lid kartasidagi mijozni tahrirlash: ism, familiya, telefon, Telegram. Instagram identifikatorlari va yozishmalar o'zgarmaydi. */
  async editContact(actor: UserActor, leadId: string, input: ContactEditInput) {
    return this.d.prisma.$transaction(async (tx) => {
      const lead = assertFound(await tx.lead.findFirst({ where: leadWhere(actor, { id: leadId }) }), 'Лид');
      if (!canEditRecord(actor, lead.ownerId)) throw forbidden();
      const c = assertFound(await tx.contact.findFirst({ where: { id: lead.contactId, companyId: actor.companyId, deletedAt: null } }), 'Контакт');
      if (c.piiErasedAt) throw unprocessable('CONTACT_ERASED', 'Нельзя редактировать контакт, чьи персональные данные удалены');
      const data: Prisma.ContactUpdateInput = { version: { increment: 1 } };
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};

      const nameTouched = input.firstName !== undefined || input.lastName !== undefined;
      if (nameTouched) {
        const first = input.firstName !== undefined ? clean(input.firstName) : c.firstName;
        const last = input.lastName !== undefined ? clean(input.lastName) : c.lastName;
        if (!first && !last) throw unprocessable('NAME_REQUIRED', 'Должно остаться хотя бы имя или фамилия', { firstName: 'required', lastName: 'required' });
        Object.assign(data, { firstName: first, lastName: last, fullName: fullNameOf(first, last) });
        Object.assign(before, { firstName: c.firstName, lastName: c.lastName, fullName: c.fullName });
        Object.assign(after, { firstName: first, lastName: last, fullName: fullNameOf(first, last) });
      }
      if (input.telegram !== undefined) {
        const tg = normalizeTelegram(input.telegram);
        if (tg === 'invalid') throw unprocessable('TELEGRAM_INVALID', 'Неверный Telegram username (5–32 символа: буквы, цифры, подчёркивание)', { telegram: 'invalid' });
        data.telegramUsername = tg;
        before.telegram = c.telegramUsername;
        after.telegram = tg;
      }
      if (input.instagram !== undefined) {
        const ig = normalizeInstagram(input.instagram);
        if (ig === 'invalid') throw unprocessable('INSTAGRAM_INVALID', IG_INVALID, { instagram: 'invalid' });
        if (ig !== c.instagramUsername) {
          // Клиент из Instagram Direct: username приходит из Instagram и вручную не меняется.
          if (await tx.conversation.count({ where: { companyId: actor.companyId, contactId: c.id } })) throw unprocessable('INSTAGRAM_FROM_DIRECT', 'Instagram username этого клиента получен из Instagram и не редактируется', { instagram: 'readonly' });
          data.instagramUsername = ig;
          before.instagram = c.instagramUsername;
          after.instagram = ig;
        }
      }
      if (input.phone !== undefined) {
        const phone = await this.parsePhone(actor.companyId, input.phone);
        const current = c.primaryPhone;
        if ((phone?.normalized ?? null) !== current) {
          if (phone) {
            const h = await this.phoneHolders(actor, phone.normalized, c.id);
            if (h.total > 0 && !input.allowDuplicatePhone) throw this.phoneConflict(h);
            const others = h.total > 0 ? await tx.contactIdentifier.findMany({ where: { companyId: actor.companyId, type: 'phone', value: phone.normalized, active: true, contactId: { not: c.id } }, select: { contactId: true } }) : [];
            const mine = await tx.contactIdentifier.findFirst({ where: { companyId: actor.companyId, contactId: c.id, type: 'phone', value: phone.normalized } });
            if (mine) await tx.contactIdentifier.update({ where: { id: mine.id }, data: { active: true, shared: others.length > 0 || mine.shared } });
            else await tx.contactIdentifier.create({ data: { companyId: actor.companyId, contactId: c.id, type: 'phone', value: phone.normalized, scope: '', verified: true, shared: others.length > 0, originalValue: phone.original } });
            if (others.length > 0) await tx.duplicateCandidate.create({ data: { companyId: actor.companyId, contactIds: [...new Set([c.id, ...others.map((o) => o.contactId)])], reason: 'shared_identifier', identifier: { type: 'phone', scope: '', value: phone.normalized } } });
          }
          // Eski telefon identifikatori nofaol qilinadi (tarix saqlanadi), Instagram identifikatorlariga tegilmaydi.
          if (current) await tx.contactIdentifier.updateMany({ where: { companyId: actor.companyId, contactId: c.id, type: 'phone', value: current, ...(phone ? { NOT: { value: phone.normalized } } : {}) }, data: { active: false } });
          data.primaryPhone = phone?.normalized ?? null;
          before.phone = current;
          after.phone = phone?.normalized ?? null;
        }
      }
      if (Object.keys(after).length === 0) return tx.contact.findUniqueOrThrow({ where: { id: c.id } });
      const updated = await tx.contact.update({ where: { id: c.id }, data });
      await audit(tx, actor, { entityType: 'contact', entityId: c.id, action: 'manual_edit', oldValue: before, newValue: after });
      return updated;
    });
  }
}
