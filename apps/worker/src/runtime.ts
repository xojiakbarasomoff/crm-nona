import { hostname } from 'node:os';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Core } from '@crm/api/core';

/**
 * Worker runtime (TZ §4.1, §14.4, §19.1). PostgreSQL rows are the source of truth; BullMQ is only a
 * transport. If Redis is unavailable rows stay pending and are relayed later.
 */
export class WorkerRuntime {
  readonly id = `${hostname()}:${process.pid}`;
  private timers: NodeJS.Timeout[] = [];
  private queues: Queue[] = [];
  private workers: Worker[] = [];
  private stopping = false;
  private busy = new Set<string>();

  constructor(
    private readonly core: Core,
    private readonly redisConnection: ConnectionOptions,
  ) {}

  private every(name: string, ms: number, fn: () => Promise<unknown>) {
    const run = async () => {
      if (this.stopping || this.busy.has(name)) return;
      this.busy.add(name);
      try {
        await fn();
      } catch (err) {
        this.core.deps.logger.error({ loop: name, err: (err as Error).message }, 'worker loop failed');
      } finally {
        this.busy.delete(name);
      }
    };
    this.timers.push(setInterval(run, ms));
    void run();
  }

  async start() {
    const { config } = this.core.deps;
    const outboxQ = new Queue('outbox', { connection: this.redisConnection });
    const inboxQ = new Queue('inbox', { connection: this.redisConnection });
    this.queues.push(outboxQ, inboxQ);
    const opts = { connection: this.redisConnection, concurrency: 5 };
    this.workers.push(
      new Worker('outbox', async (job) => this.core.processing.executeOutbox(job.data.id as string), opts),
      new Worker('inbox', async (job) => this.core.processing.processInbox(job.data.id as string), opts),
    );
    for (const w of this.workers) w.on('error', (err) => this.core.deps.logger.warn({ err: err.message }, 'bullmq worker error'));

    this.every('relay', config.outboxIntervalMs, () => this.relay(outboxQ, inboxQ));
    this.every('scheduler', config.schedulerIntervalMs, () => this.schedulerTick());
    this.every('heartbeat', 15_000, () => this.heartbeat());
    this.every('reconcile', config.reconcileIntervalMs, () => this.reconcileAmo());
    this.every('housekeeping', 60_000, () => this.housekeeping());
    this.every('instagram-token', 6 * 3600_000, () => this.refreshInstagramTokens());
    this.every('instagram-profile', 60_000, () => this.retryInstagramProfiles());
    this.every('daily', 24 * 3600_000, () => this.daily());
    this.core.deps.logger.info({ worker: this.id, mode: config.mode }, 'worker started');
  }

  /** Moves due DB rows to BullMQ. jobId dedupes repeated relays of the same attempt. */
  async relay(outboxQ: Queue, inboxQ: Queue) {
    await this.core.processing.recoverExpiredLeases();
    const [inbox, outbox] = await Promise.all([this.core.processing.claimInboxBatch(100), this.core.processing.claimOutboxBatch(100)]);
    try {
      if (inbox.length) await inboxQ.addBulk(inbox.map((id) => ({ name: 'inbox', data: { id }, opts: { jobId: `inbox-${id}-${Date.now() >> 12}`, removeOnComplete: 1000, removeOnFail: 1000 } })));
      if (outbox.length) await outboxQ.addBulk(outbox.map((id) => ({ name: 'outbox', data: { id }, opts: { jobId: `outbox-${id}-${Date.now() >> 12}`, removeOnComplete: 1000, removeOnFail: 1000 } })));
    } catch (err) {
      this.core.deps.logger.warn({ err: (err as Error).message }, 'relay to Redis failed; rows stay pending in PostgreSQL');
    }
  }

  /** DB scheduler: claim → re-validate → dispatch; then escalation and missed marking. */
  async schedulerTick() {
    const ids = await this.core.reminders.claimDue(this.id, 100);
    for (const id of ids) await this.core.reminders.dispatch(id);
    await this.core.reminders.escalateOverdue();
    await this.core.reminders.markMissed();
    await this.beat('scheduler', { dispatched: ids.length });
  }

  async heartbeat() {
    await this.beat('worker', { id: this.id });
  }

  private async beat(name: string, info: Record<string, unknown>) {
    const now = new Date();
    await this.core.deps.prisma.workerHeartbeat.upsert({ where: { name }, create: { name, lastBeatAt: now, info: info as object }, update: { lastBeatAt: now, info: info as object } });
  }

  /** Incremental amoCRM reconciliation (5 min, overlap) + daily control once per 24 h. */
  async reconcileAmo() {
    const conns = await this.core.deps.prisma.integrationConnection.findMany({ where: { provider: 'AMOCRM_REST', disconnectedAt: null, health: 'ok' } });
    for (const conn of conns) {
      await this.core.amoSync.reconcile(conn);
      await this.core.amoSync.dailyAuditIfDue(conn);
    }
  }

  /** Instagram long-lived tokens (~60 days): refresh those expiring within 14 days. */
  async refreshInstagramTokens() {
    const r = await this.core.instagram.refreshDue();
    if (r.refreshed || r.failed) this.core.deps.logger.info(r, 'instagram token refresh');
    await this.beat('instagram-token', r);
  }

  /** Username'i hali olinmagan Instagram kontaktlari: nazoratli backoff bilan qayta urinish (yangi lid yaratmaydi). */
  async retryInstagramProfiles() {
    const r = await this.core.instagramProfiles.retryDue();
    if (r.checked) this.core.deps.logger.info(r, 'instagram profile retry');
    await this.beat('instagram-profile', r);
  }

  /** SLA, attachment scanning (frequent) and retention + tombstone re-application (daily). */
  async housekeeping() {
    await this.core.sla.tick();
    await this.core.attachments.scanPending();
  }

  async daily() {
    const companies = await this.core.deps.prisma.company.findMany({ select: { id: true } });
    for (const c of companies) {
      await this.core.privacy.runRetention(c.id);
      await this.core.privacy.reapplyTombstones(c.id);
    }
  }

  async stop() {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    await Promise.allSettled(this.workers.map((w) => w.close()));
    await Promise.allSettled(this.queues.map((q) => q.close()));
  }
}
