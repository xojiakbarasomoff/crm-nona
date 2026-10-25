import { createHash } from 'node:crypto';
import type { CoreDeps, UserActor } from '../context';
import { audit } from '../audit';
import { conflict, forbidden, unprocessable } from '../errors';

/**
 * Demo/sun'iy yozuvlarni aniqlash, mantiqiy eksport va (tasdiqlangan hash bilan) o'chirish.
 *
 * Qoida (har bir yozuv uchun ijobiy dalil kerak; dalil bo'lmasa «noaniq» — SAQLANADI):
 * - HAQIQIY: jonli (mode='live') ulanishdagi suhbatga ega kontakt; uning barcha lidlari, murojaatlari, buyurtmalari va yozishmalari.
 * - SUN'IY: haqiqiy emas VA (demo-ulanishdagi suhbati bor YOKI Lead Ads kanalidan kelgan murojaati bor). Lead Ads integratsiyasi bloklangan,
 *   haqiqiy Lead Ads ulanishi yo'q, shuning uchun u kanaldagi har qanday yozuv demo adapterdan keladi.
 * - NOANIQ: boshqa hamma narsa (qo'lda yaratilgan va h.k.) — saqlanadi va hisobotda ko'rsatiladi.
 *
 * O'chirish faqat aniq ID to'plamlari bo'yicha, bitta tranzaksiyada va faqat eksport hash'i mos kelganda; har bir jadval bo'yicha o'chirilgan
 * qatorlar soni eksportdagi soniga teng bo'lmasa — hammasi bekor qilinadi. TRUNCATE/reset/seed yo'q; audit jurnali tegilmaydi.
 */

interface Sets {
  C: string[]; // demo kontaktlar
  L: string[]; // demo lidlar
  O: string[]; // demo buyurtmalar
  CONV: string[];
  INQ: string[];
  P: string[];
  S: string[];
  T: string[];
  OCC: string[];
  TASK: string[];
  ATT: string[];
  /** Haqiqiy / noaniq yozuvlar (o'chirishdan himoya tekshiruvi uchun) */
  realContacts: string[];
  realLeads: string[];
  uncertainContacts: string[];
  uncertainLeads: string[];
  demoAccounts: string[];
  liveConvIds: string[];
}

interface Only {
  contacts: string[];
  leads: string[];
  orders: string[];
}

/** Foydalanuvchi aniq ID bilan sun'iy deb tasdiqlagan yozuvlar (avtomatik tasniflash «noaniq» desa ham); haqiqiy yozuvga hech qachon qo'llanmaydi. */
interface Include {
  contacts: string[];
  leads: string[];
}

interface TableSpec {
  table: string;
  where: string;
  args: (s: Sets, rx: { links: string; ids: string; cutoff: string | null }) => unknown[];
}

const idRx = (ids: string[]) => ids.join('|');
const U = '::uuid[]';

/** O'chirish tartibi (bolalar → ota): barcha FK'lar RESTRICT. Tiklash teskari tartibda. */
const SPECS: TableSpec[] = [
  { table: 'notification_deliveries', where: `occurrence_id = ANY($1${U})`, args: (s) => [s.OCC] },
  { table: 'notifications', where: `occurrence_id = ANY($1${U}) OR (link IS NOT NULL AND link ~ $2)`, args: (s, rx) => [s.OCC, rx.links] },
  { table: 'flight_checks', where: `segment_id = ANY($1${U})`, args: (s) => [s.S] },
  { table: 'customer_notifications', where: `segment_id = ANY($1${U})`, args: (s) => [s.S] },
  { table: 'ticket_segments', where: `ticket_id = ANY($1${U}) OR segment_id = ANY($2${U})`, args: (s) => [s.T, s.S] },
  { table: 'segment_passengers', where: `segment_id = ANY($1${U}) OR passenger_id = ANY($2${U})`, args: (s) => [s.S, s.P] },
  { table: 'segment_revisions', where: `segment_id = ANY($1${U})`, args: (s) => [s.S] },
  { table: 'reminder_occurrences', where: `id = ANY($1${U})`, args: (s) => [s.OCC] },
  { table: 'tickets', where: `id = ANY($1${U})`, args: (s) => [s.T] },
  { table: 'flight_segments', where: `id = ANY($1${U})`, args: (s) => [s.S] },
  { table: 'passengers', where: `id = ANY($1${U})`, args: (s) => [s.P] },
  { table: 'supplier_refunds', where: `order_id = ANY($1${U})`, args: (s) => [s.O] },
  { table: 'order_services', where: `order_id = ANY($1${U})`, args: (s) => [s.O] },
  { table: 'payments', where: `order_id = ANY($1${U})`, args: (s) => [s.O] },
  { table: 'attachments', where: `id = ANY($1${U})`, args: (s) => [s.ATT] },
  { table: 'crm_tasks', where: `id = ANY($1${U})`, args: (s) => [s.TASK] },
  { table: 'integration_mappings', where: `local_id = ANY($1::text[])`, args: (s) => [[...s.L, ...s.O, ...s.C, ...s.TASK, ...s.INQ]] },
  { table: 'orders', where: `id = ANY($1${U})`, args: (s) => [s.O] },
  { table: 'offers', where: `lead_id = ANY($1${U})`, args: (s) => [s.L] },
  { table: 'lead_events', where: `lead_id = ANY($1${U})`, args: (s) => [s.L] },
  { table: 'messages', where: `conversation_id = ANY($1${U})`, args: (s) => [s.CONV] },
  { table: 'conversations', where: `id = ANY($1${U})`, args: (s) => [s.CONV] },
  { table: 'inquiries', where: `id = ANY($1${U})`, args: (s) => [s.INQ] },
  { table: 'leads', where: `id = ANY($1${U})`, args: (s) => [s.L] },
  { table: 'contact_identifiers', where: `contact_id = ANY($1${U})`, args: (s) => [s.C] },
  // Faqat TO'LIQ demo kontaktlardan iborat nomzodlar; haqiqiy/noaniq kontakt bilan aralash bo'lsa saqlanadi.
  { table: 'duplicate_candidates', where: `array_length(contact_ids, 1) > 0 AND contact_ids <@ $1::text[]`, args: (s) => [s.C] },
  { table: 'pii_tombstones', where: `contact_id = ANY($1${U})`, args: (s) => [s.C] },
  { table: 'contacts', where: `id = ANY($1${U})`, args: (s) => [s.C] },
  { table: 'webhook_inbox', where: `provider = 'meta' AND connection_key = ANY($1::text[]) AND received_at <= coalesce($2::timestamptz, 'infinity'::timestamptz)`, args: (s, rx) => [s.demoAccounts, rx.cutoff] },
  { table: 'outbox_operations', where: `payload::text ~ $1`, args: (_s, rx) => [rx.ids] },
];

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export class DemoCleanupService {
  constructor(private readonly d: CoreDeps) {}

  private requireAdmin(actor: UserActor) {
    if (actor.role !== 'ADMIN') throw forbidden();
  }

  /** Sun'iy / haqiqiy / noaniq to'plamlar va barcha bog'liq ID'lar. */
  private async buildSets(companyId: string, only?: Only, include?: Include) {
    const p = this.d.prisma;
    const [conns, contacts, convs, inquiries, leads, orders] = await Promise.all([
      p.integrationConnection.findMany({ where: { companyId }, select: { id: true, provider: true, mode: true, accountId: true, disconnectedAt: true } }),
      p.contact.findMany({ where: { companyId }, select: { id: true, fullName: true, instagramUsername: true, createdAt: true } }),
      p.conversation.findMany({ where: { companyId }, select: { id: true, connectionId: true, contactId: true, leadId: true } }),
      p.inquiry.findMany({ where: { companyId }, select: { id: true, contactId: true, leadId: true, channel: true } }),
      p.lead.findMany({ where: { companyId }, select: { id: true, name: true, contactId: true, firstSource: true, createdAt: true } }),
      p.order.findMany({ where: { companyId }, select: { id: true, orderNo: true, leadId: true, contactId: true } }),
    ]);
    const liveConn = new Set(conns.filter((c) => c.mode === 'live').map((c) => c.id));
    const demoConn = new Set(conns.filter((c) => c.mode !== 'live').map((c) => c.id));
    const LEAD_ADS = new Set(['meta_lead_ads', 'instagram_lead_ads']);

    const realContacts = new Set<string>();
    const synthEvidence = new Map<string, string[]>();
    const note = (id: string, why: string) => synthEvidence.set(id, [...(synthEvidence.get(id) ?? []), why]);
    for (const c of convs) {
      if (liveConn.has(c.connectionId)) realContacts.add(c.contactId);
      else if (demoConn.has(c.connectionId)) note(c.contactId, 'беседа в демо-подключении');
    }
    for (const i of inquiries) if (i.contactId && LEAD_ADS.has(i.channel)) note(i.contactId, `Lead Ads murojaati (${i.channel})`);

    const kind = (contactId: string): 'real' | 'demo' | 'uncertain' => (realContacts.has(contactId) ? 'real' : synthEvidence.has(contactId) ? 'demo' : 'uncertain');
    const contactKind = new Map(contacts.map((c) => [c.id, kind(c.id)]));
    const leadKind = new Map<string, 'real' | 'demo' | 'uncertain'>(leads.map((l) => [l.id, contactKind.get(l.contactId) ?? 'uncertain']));
    for (const c of convs) if (c.leadId && leadKind.get(c.leadId) !== contactKind.get(c.contactId)) leadKind.set(c.leadId, 'uncertain');
    const orderKind = new Map(orders.map((o) => [o.id, o.leadId && leadKind.get(o.leadId) === 'demo' && contactKind.get(o.contactId) === 'demo' ? 'demo' : o.leadId && leadKind.get(o.leadId) === 'real' ? 'real' : 'uncertain']));

    const pick = (m: Map<string, string>, k: string) => [...m].filter(([, v]) => v === k).map(([id]) => id).sort();
    let C = pick(contactKind, 'demo');
    let L = pick(leadKind, 'demo');
    let O = pick(orderKind, 'demo');
    if (include) {
      // Faqat «noaniq» yozuvlar sun'iy deb belgilanadi; haqiqiy (jonli suhbatli) bo'lsa — rad etiladi. Bog'liq buyurtma bo'lsa u ham tekshiruvdan o'tmaguncha to'xtatiladi.
      for (const id of [...include.contacts, ...include.leads]) {
        if (realContacts.has(id) || leadKind.get(id) === 'real') throw conflict('INCLUDE_IS_REAL', 'Добавленная запись относится к реальному клиенту Instagram; остановлено');
      }
      for (const id of include.contacts) if (!contactKind.has(id)) throw conflict('INCLUDE_NOT_FOUND', 'Добавленный контакт не найден');
      for (const id of include.leads) if (!leadKind.has(id)) throw conflict('INCLUDE_NOT_FOUND', 'Добавленный лид не найден');
      const leadContact = new Map(leads.map((l) => [l.id, l.contactId]));
      const extraOrders = orders.filter((o) => (o.leadId && include.leads.includes(o.leadId)) || include.contacts.includes(o.contactId)).map((o) => o.id);
      C = [...new Set([...C, ...include.contacts, ...include.leads.map((id) => leadContact.get(id)!)])].sort();
      L = [...new Set([...L, ...include.leads, ...leads.filter((l) => include.contacts.includes(l.contactId)).map((l) => l.id)])].sort();
      O = [...new Set([...O, ...extraOrders])].sort();
      // Qo'shilgan kontaktda boshqa lid bo'lsa (tasdiqlanmagan) — to'xtatamiz.
      const strangers = leads.filter((l) => C.includes(l.contactId) && !L.includes(l.id));
      if (strangers.length) throw conflict('INCLUDE_HAS_OTHER_LEADS', 'У добавленного контакта есть другой лид, которого нет в списке; остановлено');
    }
    if (only) {
      // Faqat tasdiqlangan eksportdagi ID'lar: ularning har biri hozir ham sun'iy bo'lishi shart; eksportdan keyin kelgan yangi yozuvlarga tegilmaydi.
      for (const [name, list, cur] of [['contacts', only.contacts, C], ['leads', only.leads, L], ['orders', only.orders, O]] as const) {
        const have = new Set(cur);
        const bad = list.filter((id) => !have.has(id));
        if (bad.length) throw conflict('EXPORT_RECORD_CHANGED', `Запись «${name}» из выгрузки больше не считается искусственной или отсутствует (${bad.length}); остановлено`);
      }
      C = [...only.contacts].sort();
      L = [...only.leads].sort();
      O = [...only.orders].sort();
    }
    const cSet = new Set(C);
    const lSet = new Set(L);
    const CONV = convs.filter((c) => cSet.has(c.contactId)).map((c) => c.id).sort();
    const INQ = inquiries.filter((i) => (i.contactId && cSet.has(i.contactId)) || (i.leadId && lSet.has(i.leadId))).map((i) => i.id).sort();

    const [passengers, segments] = await Promise.all([p.passenger.findMany({ where: { companyId, orderId: { in: O } }, select: { id: true } }), p.flightSegment.findMany({ where: { companyId, orderId: { in: O } }, select: { id: true } })]);
    const P = passengers.map((x) => x.id).sort();
    const S = segments.map((x) => x.id).sort();
    const [tickets, occurrences, tasks, atts] = await Promise.all([
      p.ticket.findMany({ where: { companyId, passengerId: { in: P } }, select: { id: true } }),
      p.reminderOccurrence.findMany({ where: { companyId, OR: [{ orderId: { in: O } }, { segmentId: { in: S } }] }, select: { id: true } }),
      p.crmTask.findMany({ where: { companyId, entityId: { in: [...L, ...O, ...C] } }, select: { id: true } }),
      p.attachment.findMany({ where: { companyId, ownerId: { in: [...L, ...O, ...C, ...P] } }, select: { id: true } }),
    ]);
    const sets: Sets = {
      C, L, O, CONV, INQ, P, S,
      T: tickets.map((x) => x.id).sort(),
      OCC: occurrences.map((x) => x.id).sort(),
      TASK: tasks.map((x) => x.id).sort(),
      ATT: atts.map((x) => x.id).sort(),
      realContacts: pick(contactKind, 'real'),
      realLeads: pick(leadKind, 'real'),
      uncertainContacts: pick(contactKind, 'uncertain'),
      uncertainLeads: pick(leadKind, 'uncertain'),
      demoAccounts: conns.filter((c) => c.mode !== 'live').map((c) => c.accountId).sort(),
      liveConvIds: convs.filter((c) => liveConn.has(c.connectionId)).map((c) => c.id).sort(),
    };
    // Himoya: o'chiriladigan to'plamlar haqiqiy/noaniq bilan kesishmasligi va jonli suhbatlarga tegmasligi shart.
    const del = new Set([...sets.C, ...sets.L]);
    const included = new Set([...(include?.contacts ?? []), ...(include?.leads ?? []), ...C, ...L]);
    const protect = [...sets.realContacts, ...sets.realLeads, ...sets.uncertainContacts.filter((id) => !included.has(id)), ...sets.uncertainLeads.filter((id) => !included.has(id))];
    if (protect.some((id) => del.has(id)) || sets.CONV.some((id) => sets.liveConvIds.includes(id))) throw conflict('CLEANUP_SAFETY', 'Проверка защиты: набор удаления пересёкся с реальной записью; остановлено');
    const info = {
      conns, contacts, leads, orders, contactKind, leadKind, orderKind, synthEvidence,
      nameOf: new Map(leads.map((l) => [l.id, l.name])),
    };
    return { sets, info };
  }

  private regexes(s: Sets, cutoff: string | null = null) {
    const linkIds = [...s.L, ...s.O, ...s.C];
    const allIds = [...s.L, ...s.O, ...s.C, ...s.INQ, ...s.TASK, ...s.P, ...s.S, ...s.ATT];
    // Bo'sh to'plam hech narsaga mos kelmaydigan regex bo'lsin (^$ bo'sh matnga ham mos kelmasligi uchun maxsus belgi).
    const never = '(?!x)x';
    return { links: linkIds.length ? `/(leads|orders|contacts)/(${idRx(linkIds)})($|[/?#])` : never, ids: allIds.length ? idRx(allIds) : never, cutoff };
  }

  private manifestHash(s: Sets, counts: Record<string, number>) {
    return sha({ C: s.C, L: s.L, O: s.O, CONV: s.CONV, INQ: s.INQ, P: s.P, S: s.S, T: s.T, OCC: s.OCC, TASK: s.TASK, ATT: s.ATT, demoAccounts: s.demoAccounts, counts });
  }

  private async countRows(s: Sets, cutoff: string | null = null): Promise<Record<string, number>> {
    const rx = this.regexes(s, cutoff);
    const out: Record<string, number> = {};
    for (const spec of SPECS) {
      const rows = await this.d.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${spec.table}" WHERE ${spec.where}`, ...spec.args(s, rx));
      out[spec.table] = Number(rows[0]?.n ?? 0);
    }
    return out;
  }

  async plan(actor: UserActor) {
    this.requireAdmin(actor);
    const { sets, info } = await this.buildSets(actor.companyId);
    const counts = await this.countRows(sets);
    const uncertainSet = new Set(sets.uncertainContacts);
    return {
      generatedAt: this.d.clock.now().toISOString(),
      note: 'Только план (чтение). Ничего не удалено.',
      manifestHash: this.manifestHash(sets, counts),
      connections: info.conns.map((c) => ({ id: c.id, provider: c.provider, mode: c.mode, accountId: c.accountId, active: !c.disconnectedAt })),
      totals: { contacts: info.contacts.length, leads: info.leads.length, orders: info.orders.length },
      keep: {
        realContacts: sets.realContacts,
        realLeads: sets.realLeads.map((id) => ({ id, name: info.nameOf.get(id) })),
        uncertain: {
          contacts: info.contacts.filter((c) => uncertainSet.has(c.id)).map((c) => ({ id: c.id, name: c.fullName ?? c.instagramUsername, createdAt: c.createdAt })),
          leads: info.leads.filter((l) => sets.uncertainLeads.includes(l.id)).map((l) => ({ id: l.id, name: l.name, source: l.firstSource, createdAt: l.createdAt })),
          orders: info.orders.filter((o) => info.orderKind.get(o.id) === 'uncertain').map((o) => ({ id: o.id, orderNo: o.orderNo })),
        },
      },
      delete: {
        contacts: sets.C.map((id) => ({ id, why: info.synthEvidence.get(id) })),
        leads: sets.L.map((id) => ({ id, name: info.nameOf.get(id) })),
        orders: info.orders.filter((o) => sets.O.includes(o.id)).map((o) => ({ id: o.id, orderNo: o.orderNo })),
        rowsPerTable: counts,
      },
    };
  }

  /** Mantiqiy eksport: o'chiriladigan HAR BIR qator to'liq (DB ustun nomlari bilan, to_jsonb). Tiklash: jsonb_populate_recordset. */
  async export(actor: UserActor, include?: Include) {
    this.requireAdmin(actor);
    const { sets } = await this.buildSets(actor.companyId, undefined, include);
    const rx = this.regexes(sets);
    const tables: Array<{ table: string; count: number; sha256: string; rows: unknown[] }> = [];
    const counts: Record<string, number> = {};
    for (const spec of SPECS) {
      const r = await this.d.prisma.$queryRawUnsafe<Array<{ rows: unknown[] }>>(`SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows FROM "${spec.table}" t WHERE ${spec.where}`, ...spec.args(sets, rx));
      const rows = (r[0]?.rows ?? []) as unknown[];
      counts[spec.table] = rows.length;
      tables.push({ table: spec.table, count: rows.length, sha256: sha(rows), rows });
    }
    const integrity = await this.integrity(tables);
    return {
      format: 'crm-demo-cleanup-export/1',
      generatedAt: this.d.clock.now().toISOString(),
      companyId: actor.companyId,
      note: 'Порядок удаления (дочерние → родительские). Восстановление в обратном порядке: INSERT INTO t SELECT * FROM jsonb_populate_recordset(NULL::t, rows).',
      manifestHash: this.manifestHash(sets, counts),
      sets: { contacts: sets.C, leads: sets.L, orders: sets.O, inquiries: sets.INQ, conversations: sets.CONV, passengers: sets.P, segments: sets.S, tickets: sets.T, occurrences: sets.OCC, tasks: sets.TASK, attachments: sets.ATT, demoAccounts: sets.demoAccounts },
      counts,
      integrity,
      tables,
    };
  }

  /**
   * Tiklash uchun tashqi bog'liqliklar tekshiruvi: eksport qatorlari havola qiladigan ota-yozuvlar (xodim, yetkazib beruvchi, ulanish, kompaniya, taklif)
   * hozirgi bazada yoki eksportning o'zida mavjudmi. `missing` bo'sh bo'lsa, tiklash FK'ga zid kelmaydi.
   */
  private async integrity(tables: Array<{ table: string; rows: unknown[] }>) {
    const USER_COLS = ['owner_id', 'responsible_user_id', 'uploaded_by_id', 'recorded_by_id', 'assignee_id', 'created_by_id', 'checked_by_id', 'actor_user_id'];
    const refs: Record<string, { table: string; ids: Set<string> }> = {
      users: { table: 'users', ids: new Set() },
      suppliers: { table: 'suppliers', ids: new Set() },
      connections: { table: 'integration_connections', ids: new Set() },
      companies: { table: 'companies', ids: new Set() },
    };
    const inExport = new Map<string, Set<string>>(tables.map((t) => [t.table, new Set((t.rows as Array<{ id?: string }>).map((r) => r.id ?? ''))]));
    const offerRefs = new Set<string>();
    for (const t of tables) {
      for (const row of t.rows as Array<Record<string, unknown>>) {
        for (const c of USER_COLS) if (typeof row[c] === 'string') refs.users!.ids.add(row[c] as string);
        for (const c of ['supplier_id', 'tour_operator_id']) if (typeof row[c] === 'string') refs.suppliers!.ids.add(row[c] as string);
        if (typeof row.connection_id === 'string') refs.connections!.ids.add(row.connection_id);
        if (typeof row.company_id === 'string') refs.companies!.ids.add(row.company_id);
        if (typeof row.offer_version_id === 'string') offerRefs.add(row.offer_version_id);
      }
    }
    const out: Record<string, { referenced: number; missing: string[] }> = {};
    for (const [k, r] of Object.entries(refs)) {
      const ids = [...r.ids];
      const found = ids.length ? await this.d.prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text AS id FROM "${r.table}" WHERE id = ANY($1::uuid[])`, ids) : [];
      const have = new Set(found.map((x) => x.id));
      out[k] = { referenced: ids.length, missing: ids.filter((id) => !have.has(id)) };
    }
    const offerIds = [...offerRefs];
    const offerFound = offerIds.length ? await this.d.prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text AS id FROM "offers" WHERE id = ANY($1::uuid[])`, offerIds) : [];
    const haveOffers = new Set([...offerFound.map((x) => x.id), ...(inExport.get('offers') ?? [])]);
    out.offers = { referenced: offerIds.length, missing: offerIds.filter((id) => !haveOffers.has(id)) };
    return out;
  }

  /**
   * O'chirish: faqat eksport hash'i mos kelganda; bitta tranzaksiya; har jadvalda o'chirilgan soni oldindan sanalgan songa teng bo'lishi shart.
   * Dashboard keshi (faqat `dash:<kompaniya>:*`) tozalanadi; Redis/navbatlar umumiy tozalanmaydi.
   */
  async execute(actor: UserActor, input: { manifestHash: string; confirm: string; allowPaymentDeletion?: string; only?: Only; cutoff?: string; include?: Include }) {
    this.requireAdmin(actor);
    if (input.confirm !== 'DELETE-DEMO-RECORDS') throw unprocessable('CONFIRM_REQUIRED', 'Неверный текст подтверждения');
    const cutoff = input.cutoff ? new Date(input.cutoff).toISOString() : null;
    if (input.only && !cutoff) throw unprocessable('CUTOFF_REQUIRED', 'Вместе с only нужно указать время выгрузки (cutoff)');
    const { sets } = await this.buildSets(actor.companyId, input.only, input.include);
    const counts = await this.countRows(sets, cutoff);
    if (this.manifestHash(sets, counts) !== input.manifestHash) throw conflict('MANIFEST_MISMATCH', 'Данные изменились после выгрузки; выполните выгрузку заново');
    const rx = this.regexes(sets, cutoff);
    const before = await this.keepCounts(actor.companyId);
    const deleted: Record<string, number> = {};
    try {
      await this.runDelete(actor, input.manifestHash, sets, counts, rx, deleted, input.allowPaymentDeletion === 'DELETE-DEMO-PAYMENTS');
    } catch (err) {
      if (/payments cannot be deleted/i.test((err as Error).message ?? '')) {
        throw conflict('PAYMENTS_PROTECTED', 'Финансовая защита базы не позволяет удалять платежи (платёж меняется только возвратом/отменой). Ничего не удалено.');
      }
      if ((err as { meta?: { code?: string } }).meta?.code === '23503' || /foreign key/i.test((err as Error).message ?? '')) {
        throw conflict('DELETE_BLOCKED_BY_REFERENCE', 'Другая (не удаляемая) запись ссылается на удаляемую; всё отменено, триггер не изменён.');
      }
      throw err;
    }
    const after = await this.keepCounts(actor.companyId);
    // Faqat dashboard keshi
    let cacheKeysDeleted = 0;
    try {
      const keys = await this.scan(`dash:${actor.companyId}:*`);
      if (keys.length) cacheKeysDeleted = await this.d.redis.del(...keys);
    } catch {
      /* kesh 20 soniyalik; muvaffaqiyatsizlik muhim emas */
    }
    return { deleted, before, after, cacheKeysDeleted };
  }

  private async runDelete(actor: UserActor, manifestHash: string, sets: Sets, counts: Record<string, number>, rx: { links: string; ids: string; cutoff: string | null }, deleted: Record<string, number>, unlockPayments: boolean) {
    await this.d.prisma.$transaction(
      async (tx) => {
        for (const spec of SPECS) {
          // Moliyaviy himoya (payments_no_delete): faqat aniq so'ralganda va FAQAT shu tranzaksiya ichida o'chiriladi; commit'dan oldin qayta yoqiladi va tekshiriladi.
          const unlock = spec.table === 'payments' && unlockPayments && (counts.payments ?? 0) > 0;
          if (unlock) await tx.$executeRawUnsafe('ALTER TABLE "payments" DISABLE TRIGGER payments_no_delete');
          const n = await tx.$executeRawUnsafe(`DELETE FROM "${spec.table}" WHERE ${spec.where}`, ...spec.args(sets, rx));
          if (unlock) {
            await tx.$executeRawUnsafe('ALTER TABLE "payments" ENABLE TRIGGER payments_no_delete');
            const t = await tx.$queryRawUnsafe<Array<{ tgenabled: string }>>(`SELECT tgenabled::text AS tgenabled FROM pg_trigger WHERE tgname = 'payments_no_delete' AND tgrelid = '"payments"'::regclass`);
            if (t[0]?.tgenabled !== 'O') throw conflict('TRIGGER_NOT_RESTORED', 'триггер payments_no_delete не включён обратно; всё отменено');
          }
          if (n !== counts[spec.table]) throw conflict('DELETE_COUNT_MISMATCH', `${spec.table}: удалено ${n}, ожидалось ${counts[spec.table]}; всё отменено`);
          deleted[spec.table] = n;
        }
        await audit(tx, actor, { entityType: 'company', entityId: actor.companyId, action: 'demo_cleanup_executed', newValue: { manifestHash, deleted } });
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
  }

  private async scan(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.d.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  /** Saqlanishi shart bo'lgan jadvallar soni (o'chirishdan oldin/keyin solishtirish uchun). */
  async keepCounts(companyId: string) {
    const p = this.d.prisma;
    const [contacts, leads, conversations, messages, connections, users, sessions, auditLogs, contactIdentifiers, webhookInboxReal] = await Promise.all([
      p.contact.count({ where: { companyId } }),
      p.lead.count({ where: { companyId } }),
      p.conversation.count({ where: { companyId } }),
      p.message.count({ where: { companyId } }),
      p.integrationConnection.count({ where: { companyId } }),
      p.user.count({ where: { companyId } }),
      p.session.count(),
      p.auditLog.count({ where: { companyId } }),
      p.contactIdentifier.count({ where: { companyId } }),
      p.webhookInbox.count({ where: { companyId } }),
    ]);
    return { contacts, leads, conversations, messages, connections, users, sessions, auditLogs, contactIdentifiers, webhookInbox: webhookInboxReal };
  }
}
