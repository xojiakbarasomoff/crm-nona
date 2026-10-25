import type { Supplier, Tx } from '@crm/database';
import { can } from '@crm/domain';
import { audit } from '../audit';
import type { CoreDeps, UserActor } from '../context';
import { conflict, isPgUniqueViolation, unprocessable } from '../errors';
import { assertFound, requireCap } from '../scope';

export type SupplierKind = 'tour_operator' | 'hotel' | 'transfer' | 'airline' | 'other';

/**
 * Turoperatorlar va xizmat yetkazib beruvchilar ma’lumotnomasi.
 * - Yaratish/tahrirlash/arxivlash: faqat `suppliers.manage` (administrator, rahbar).
 * - Ro‘yxat barcha rollarga ochiq (menejer lidga turoperator tanlaydi), lekin aloqa ma’lumotlari
 *   faqat `reference.view_full` huquqida ko‘rinadi.
 * - Narxlar buyurtma/xizmat qatorlarida saqlanadi: ma’lumotnomani keyin o‘zgartirish eski narxlarga ta’sir qilmaydi.
 */
export function serializeSupplier(s: Supplier, full: boolean) {
  const base = { id: s.id, name: s.name, kind: s.kind as SupplierKind, status: s.status as 'active' | 'archived' };
  return full ? { ...base, contactPerson: s.contactPerson, phone: s.phone, email: s.email, note: s.note, version: s.version, createdAt: s.createdAt, updatedAt: s.updatedAt } : base;
}

/** Yangi tanlov uchun: yetkazib beruvchi shu kompaniyada va faol bo‘lishi kerak (o‘zgarmagan eski tanlov bundan mustasno). */
export async function assertSelectableSupplier(tx: Tx, companyId: string, supplierId: string, opts: { kind?: SupplierKind; unchanged?: boolean } = {}): Promise<Supplier> {
  const s = await tx.supplier.findFirst({ where: { id: supplierId, companyId } });
  if (!s) throw unprocessable('SUPPLIER_NOT_FOUND', 'Turoperator/yetkazib beruvchi topilmadi', { supplierId: 'not_found' });
  if (s.status === 'archived' && !opts.unchanged) throw unprocessable('SUPPLIER_ARCHIVED', 'Arxivdagi turoperatorni yangi tanlab bo‘lmaydi', { supplierId: 'archived' });
  if (opts.kind && s.kind !== opts.kind) throw unprocessable('SUPPLIER_KIND_MISMATCH', 'Bu maydon uchun boshqa turdagi yetkazib beruvchi kerak', { supplierId: `expected_${opts.kind}` });
  return s;
}

export class SuppliersService {
  constructor(private readonly d: CoreDeps) {}

  async list(actor: UserActor, q: { status: 'active' | 'archived' | 'all'; kind?: SupplierKind; q?: string }) {
    const full = can(actor.role, 'reference.view_full');
    const rows = await this.d.prisma.supplier.findMany({
      where: {
        companyId: actor.companyId,
        ...(q.status === 'all' ? {} : { status: q.status }),
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
      },
      orderBy: [{ name: 'asc' }],
      take: 500,
    });
    return { items: rows.map((r) => serializeSupplier(r, full)) };
  }

  async create(actor: UserActor, input: { name: string; kind: SupplierKind; contactPerson?: string | null; phone?: string | null; email?: string | null; note?: string | null }) {
    requireCap(actor, 'suppliers.manage');
    try {
      return await this.d.prisma.$transaction(async (tx) => {
        const s = await tx.supplier.create({
          data: { companyId: actor.companyId, name: input.name.trim(), kind: input.kind, contactPerson: input.contactPerson ?? null, phone: input.phone ?? null, email: input.email ?? null, note: input.note ?? null },
        });
        await audit(tx, actor, { entityType: 'supplier', entityId: s.id, action: 'created', newValue: { name: s.name, kind: s.kind } });
        return serializeSupplier(s, true);
      });
    } catch (err) {
      if (isPgUniqueViolation(err)) throw conflict('SUPPLIER_NAME_EXISTS', 'Bu nomli turoperator/yetkazib beruvchi allaqachon mavjud');
      throw err;
    }
  }

  async update(actor: UserActor, id: string, patch: { version: number; name?: string; kind?: SupplierKind; contactPerson?: string | null; phone?: string | null; email?: string | null; note?: string | null; status?: 'active' | 'archived' }) {
    requireCap(actor, 'suppliers.manage');
    const { version, ...fields } = patch;
    try {
      return await this.d.prisma.$transaction(async (tx) => {
        const before = assertFound(await tx.supplier.findFirst({ where: { id, companyId: actor.companyId } }), 'Turoperator');
        const data: Record<string, unknown> = { version: { increment: 1 } };
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) data[k] = k === 'name' ? (v as string).trim() : v;
        const res = await tx.supplier.updateMany({ where: { id, companyId: actor.companyId, version }, data });
        if (res.count !== 1) throw conflict('VERSION_CONFLICT', 'Ma’lumot boshqa foydalanuvchi tomonidan o‘zgartirilgan. Sahifani yangilang.');
        const after = await tx.supplier.findUniqueOrThrow({ where: { id } });
        const action = fields.status && fields.status !== before.status ? (fields.status === 'archived' ? 'archived' : 'restored') : 'updated';
        await audit(tx, actor, {
          entityType: 'supplier',
          entityId: id,
          action,
          oldValue: { name: before.name, kind: before.kind, status: before.status, contactPerson: before.contactPerson, phone: before.phone, email: before.email, note: before.note },
          newValue: fields,
        });
        return serializeSupplier(after, true);
      });
    } catch (err) {
      if (isPgUniqueViolation(err)) throw conflict('SUPPLIER_NAME_EXISTS', 'Bu nomli turoperator/yetkazib beruvchi allaqachon mavjud');
      throw err;
    }
  }
}
