import { audit } from '../audit';
import { systemActor, type CoreDeps } from '../context';
import { headRecipients, notify, publishEvent } from '../events';

/**
 * First-response SLA signals (TZ §10): the deadline is computed in working time when the lead is
 * created (`first_response_due_at`). Approaching → manager notification; breached → manager and
 * head notifications plus `sla_breached_at`. There is no automatic reassignment by default.
 */
export class SlaService {
  constructor(private readonly d: CoreDeps) {}

  async tick(): Promise<{ warned: number; breached: number }> {
    const now = this.d.clock.now();
    const warnUntil = new Date(now.getTime() + this.d.config.slaWarnMinutes * 60_000);

    const approaching = await this.d.prisma.lead.findMany({
      where: { firstHumanActionAt: null, slaBreachedAt: null, deletedAt: null, stage: { notIn: ['WON', 'LOST'] }, firstResponseDueAt: { gt: now, lte: warnUntil }, ownerId: { not: null } },
      select: { id: true, companyId: true, ownerId: true, name: true, firstResponseDueAt: true },
      take: 500,
    });
    let warned = 0;
    for (const l of approaching) {
      const created = await notify(this.d.prisma, {
        companyId: l.companyId,
        userId: l.ownerId!,
        kind: 'sla_warning',
        dedupeKey: `sla_warn:${l.id}`,
        title: `SLA yaqinlashmoqda: ${l.name}`,
        body: `Birinchi javob muddati: ${l.firstResponseDueAt!.toISOString()}`,
        link: `/leads/${l.id}`,
      });
      if (created) warned++;
    }

    const due = await this.d.prisma.$queryRaw<Array<{ id: string; company_id: string; owner_id: string | null; name: string }>>`
      UPDATE leads SET sla_breached_at = ${now}
      WHERE id IN (SELECT id FROM leads WHERE first_human_action_at IS NULL AND sla_breached_at IS NULL AND deleted_at IS NULL
                   AND stage NOT IN ('WON', 'LOST') AND first_response_due_at <= ${now} LIMIT 500 FOR UPDATE SKIP LOCKED)
      RETURNING id, company_id, owner_id, name`;
    for (const l of due) {
      await this.d.prisma.$transaction(async (tx) => {
        const recipients = new Set([...(l.owner_id ? [l.owner_id] : []), ...(await headRecipients(tx, l.company_id))]);
        for (const uid of recipients) {
          await notify(tx, { companyId: l.company_id, userId: uid, kind: 'sla_breached', dedupeKey: `sla_breach:${l.id}:${uid}`, title: `SLA buzildi: ${l.name}`, body: 'Birinchi inson javobi muddatida qayd etilmadi. Avtomatik qayta biriktirish yo‘q — rahbar qaror qiladi.', link: `/leads/${l.id}` });
        }
        await audit(tx, systemActor(l.company_id, 'sla'), { entityType: 'lead', entityId: l.id, action: 'sla_breached', newValue: { at: now.toISOString() } });
      });
      await publishEvent(this.d.redis, { companyId: l.company_id, entityType: 'lead', entityId: l.id, ownerId: l.owner_id, kind: 'sla_breached' });
    }
    return { warned, breached: due.length };
  }
}
