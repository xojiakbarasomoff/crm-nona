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
  if (!s) throw unprocessable('SUPPLIER_NOT_FOUND', 'Туроператор/поставщик не найден', { supplierId: 'not_found' });
  if (s.status === 'archived' && !opts.unchanged) throw unprocessable('SUPPLIER_ARCHIVED', 'Нельзя выбрать туроператора из архива', { supplierId: 'archived' });
  if (opts.kind && s.kind !== opts.kind) throw unprocessable('SUPPLIER_KIND_MISMATCH', 'Для этого поля нужен поставщик другого типа', { supplierId: `expected_${opts.kind}` });
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
      if (isPgUniqueViolation(err)) throw conflict('SUPPLIER_NAME_EXISTS', 'Туроператор/поставщик с таким названием уже существует');
      throw err;
    }
  }

  /**
   * Turoperatorlarni ma'lumotnomaga IDEMPOTENT kiritish: nom katta-kichik harfsiz solishtiriladi (bazadagi unikal indeks bilan bir xil);
   * mavjud (arxivdagi ham) yozuvga tegilmaydi, yangi yozuvlar tranzaksiyada qo'shiladi, takroriy ishga tushirish dublikat yaratmaydi.
   */
  async importTourOperators(actor: UserActor, names: string[]) {
    requireCap(actor, 'suppliers.manage');
    const wanted = new Map<string, string>();
    for (const raw of names) {
      const n = raw.trim().replace(/\s+/g, ' ');
      if (n && !wanted.has(n.toLowerCase())) wanted.set(n.toLowerCase(), n);
    }
    return this.d.prisma.$transaction(async (tx) => {
      const existing = await tx.supplier.findMany({ where: { companyId: actor.companyId }, select: { name: true, status: true } });
      const have = new Map(existing.map((e) => [e.name.trim().toLowerCase(), e.status]));
      const created: string[] = [];
      const skipped: string[] = [];
      for (const [key, name] of wanted) {
        if (have.has(key)) {
          skipped.push(name);
          continue;
        }
        const s = await tx.supplier.create({ data: { companyId: actor.companyId, name, kind: 'tour_operator' } });
        await audit(tx, actor, { entityType: 'supplier', entityId: s.id, action: 'created', newValue: { name: s.name, kind: s.kind, via: 'import' } });
        created.push(name);
      }
      return { created, skipped, createdCount: created.length, skippedCount: skipped.length };
    });
  }

  async update(actor: UserActor, id: string, patch: { version: number; name?: string; kind?: SupplierKind; contactPerson?: string | null; phone?: string | null; email?: string | null; note?: string | null; status?: 'active' | 'archived' }) {
    requireCap(actor, 'suppliers.manage');
    const { version, ...fields } = patch;
    try {
      return await this.d.prisma.$transaction(async (tx) => {
        const before = assertFound(await tx.supplier.findFirst({ where: { id, companyId: actor.companyId } }), 'Туроператор');
        const data: Record<string, unknown> = { version: { increment: 1 } };
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) data[k] = k === 'name' ? (v as string).trim() : v;
        const res = await tx.supplier.updateMany({ where: { id, companyId: actor.companyId, version }, data });
        if (res.count !== 1) throw conflict('VERSION_CONFLICT', 'Данные изменены другим пользователем. Обновите страницу.');
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
      if (isPgUniqueViolation(err)) throw conflict('SUPPLIER_NAME_EXISTS', 'Туроператор/поставщик с таким названием уже существует');
      throw err;
    }
  }
}
