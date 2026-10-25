import type { CoreDeps, UserActor } from '../context';
import { forbidden } from '../errors';

/**
 * Demo/sun'iy yozuvlarni aniqlash — FAQAT O'QISH (reja). O'chirish bu servisda YO'Q: u alohida, zaxira nusxadan keyin va
 * foydalanuvchining ruxsati bilan qo'shiladi.
 *
 * Qoida (har bir yozuv uchun ijobiy dalil kerak; dalil bo'lmasa «noaniq» — SAQLANADI):
 * - HAQIQIY: jonli (mode='live') ulanishdagi suhbatga ega kontakt; uning barcha lidlari, murojaatlari, buyurtmalari va yozishmalari.
 * - SUN'IY: haqiqiy emas VA (demo-ulanishdagi suhbati bor YOKI Lead Ads kanalidan kelgan murojaati bor). Lead Ads integratsiyasi bloklangan,
 *   haqiqiy Lead Ads ulanishi yo'q, shuning uchun u kanaldagi har qanday yozuv demo adapterdan keladi.
 * - NOANIQ: boshqa hamma narsa (qo'lda yaratilgan, amoCRM'dan import qilingan va h.k.) — saqlanadi va hisobotda ko'rsatiladi.
 */
export class DemoCleanupService {
  constructor(private readonly d: CoreDeps) {}

  async plan(actor: UserActor) {
    if (actor.role !== 'ADMIN') throw forbidden();
    const companyId = actor.companyId;
    const p = this.d.prisma;
    const [conns, contacts, convs, inquiries, leads, orders] = await Promise.all([
      p.integrationConnection.findMany({ where: { companyId }, select: { id: true, provider: true, mode: true, accountId: true, disconnectedAt: true } }),
      p.contact.findMany({ where: { companyId }, select: { id: true, fullName: true, instagramUsername: true, createdAt: true, piiErasedAt: true, deletedAt: true } }),
      p.conversation.findMany({ where: { companyId }, select: { id: true, connectionId: true, contactId: true, leadId: true } }),
      p.inquiry.findMany({ where: { companyId }, select: { id: true, contactId: true, leadId: true, channel: true } }),
      p.lead.findMany({ where: { companyId }, select: { id: true, name: true, contactId: true, firstSource: true, createdAt: true, ownerId: true, deletedAt: true } }),
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
      else if (demoConn.has(c.connectionId)) note(c.contactId, 'demo-ulanishdagi suhbat');
    }
    for (const i of inquiries) if (i.contactId && LEAD_ADS.has(i.channel)) note(i.contactId, `Lead Ads murojaati (${i.channel})`);

    const kind = (contactId: string): 'real' | 'demo' | 'uncertain' => (realContacts.has(contactId) ? 'real' : synthEvidence.has(contactId) ? 'demo' : 'uncertain');
    const contactKind = new Map(contacts.map((c) => [c.id, kind(c.id)]));
    const leadKind = new Map(leads.map((l) => [l.id, contactKind.get(l.contactId) ?? 'uncertain']));
    // Suhbatda lid ko'rsatilgan bo'lsa, u ham suhbat egasi bilan bir xil turda (kontaktdan farq qilsa — noaniq).
    for (const c of convs) if (c.leadId && leadKind.get(c.leadId) !== contactKind.get(c.contactId)) leadKind.set(c.leadId, 'uncertain');
    const orderKind = new Map(orders.map((o) => [o.id, o.leadId && leadKind.get(o.leadId) === 'demo' && contactKind.get(o.contactId) === 'demo' ? 'demo' : o.leadId && leadKind.get(o.leadId) === 'real' ? 'real' : 'uncertain']));

    const ids = (m: Map<string, string>, k: string) => [...m].filter(([, v]) => v === k).map(([id]) => id);
    const demoContactIds = ids(contactKind, 'demo');
    const demoLeadIds = ids(leadKind, 'demo');
    const demoOrderIds = ids(orderKind, 'demo');
    const demoConvIds = convs.filter((c) => contactKind.get(c.contactId) === 'demo').map((c) => c.id);
    const demoInquiryIds = inquiries.filter((i) => i.contactId && contactKind.get(i.contactId) === 'demo').map((i) => i.id);
    const demoAccounts = conns.filter((c) => c.mode !== 'live').map((c) => c.accountId);

    // Bog'liq yozuvlar soni (o'chirish rejasi; hozir o'chirilmaydi).
    const [offers, leadEvents, messages, identifiers, tasks, services, payments, passengers, segments, occurrences, attachments, refunds, inbox, mappings, notifications, outbox] = await Promise.all([
      p.offer.count({ where: { companyId, leadId: { in: demoLeadIds } } }),
      p.leadEvent.count({ where: { companyId, leadId: { in: demoLeadIds } } }),
      p.message.count({ where: { companyId, conversationId: { in: demoConvIds } } }),
      p.contactIdentifier.count({ where: { companyId, contactId: { in: demoContactIds } } }),
      p.crmTask.count({ where: { companyId, entityId: { in: [...demoLeadIds, ...demoOrderIds, ...demoContactIds] } } }),
      p.orderService.count({ where: { companyId, orderId: { in: demoOrderIds } } }),
      p.payment.count({ where: { companyId, orderId: { in: demoOrderIds } } }),
      p.passenger.count({ where: { companyId, orderId: { in: demoOrderIds } } }),
      p.flightSegment.count({ where: { companyId, orderId: { in: demoOrderIds } } }),
      p.reminderOccurrence.count({ where: { companyId, orderId: { in: demoOrderIds } } }),
      p.attachment.count({ where: { companyId, ownerId: { in: [...demoLeadIds, ...demoOrderIds, ...demoContactIds] }, deletedAt: null } }),
      p.supplierRefund.count({ where: { companyId, orderId: { in: demoOrderIds } } }),
      p.webhookInbox.count({ where: { companyId, connectionKey: { in: demoAccounts } } }),
      p.integrationMapping.count({ where: { companyId, localId: { in: [...demoLeadIds, ...demoOrderIds, ...demoContactIds] } } }),
      p.notification.count({ where: { companyId } }),
      p.outboxOperation.count({ where: { companyId } }),
    ]);

    const nameOf = new Map(leads.map((l) => [l.id, l.name]));
    return {
      generatedAt: this.d.clock.now().toISOString(),
      note: 'Faqat reja (o‘qish). Hech narsa o‘chirilmadi.',
      connections: conns.map((c) => ({ id: c.id, provider: c.provider, mode: c.mode, accountId: c.accountId, active: !c.disconnectedAt })),
      totals: { contacts: contacts.length, leads: leads.length, orders: orders.length, conversations: convs.length, inquiries: inquiries.length },
      keep: {
        realContacts: ids(contactKind, 'real'),
        realLeads: ids(leadKind, 'real').map((id) => ({ id, name: nameOf.get(id) })),
        realOrders: ids(orderKind, 'real'),
        uncertain: {
          contacts: contacts.filter((c) => contactKind.get(c.id) === 'uncertain').map((c) => ({ id: c.id, name: c.fullName ?? c.instagramUsername, createdAt: c.createdAt })),
          leads: leads.filter((l) => leadKind.get(l.id) === 'uncertain').map((l) => ({ id: l.id, name: l.name, source: l.firstSource, createdAt: l.createdAt })),
          orders: orders.filter((o) => orderKind.get(o.id) === 'uncertain').map((o) => ({ id: o.id, orderNo: o.orderNo })),
        },
      },
      delete: {
        contacts: demoContactIds.map((id) => ({ id, why: synthEvidence.get(id) })),
        leads: demoLeadIds.map((id) => ({ id, name: nameOf.get(id) })),
        orders: orders.filter((o) => orderKind.get(o.id) === 'demo').map((o) => ({ id: o.id, orderNo: o.orderNo })),
        dependents: { conversations: demoConvIds.length, messages, inquiries: demoInquiryIds.length, contactIdentifiers: identifiers, offers, leadEvents, crmTasks: tasks, orderServices: services, payments, passengers, flightSegments: segments, reminderOccurrences: occurrences, attachments, supplierRefunds: refunds, demoWebhookInbox: inbox, integrationMappings: mappings },
        notRemoved: { notificationsTotal: notifications, outboxOperationsTotal: outbox, auditLogs: 'saqlanadi', note: 'Bildirishnoma/outbox qatorlari o‘chirish bosqichida ID bo‘yicha aniqlanadi; audit jurnali o‘chirilmaydi.' },
      },
    };
  }
}
