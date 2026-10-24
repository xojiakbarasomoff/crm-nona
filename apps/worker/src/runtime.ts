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

  /**
   * Incremental amoCRM reconciliation every 5 minutes with a checkpoint and a 10-minute overlap
   * (TZ §5.2). Snapshots are applied idempotently and monotonically.
   */
  async reconcileAmo() {
    const conns = await this.core.deps.prisma.integrationConnection.findMany({ where: { provider: 'AMOCRM_REST', disconnectedAt: null, health: 'ok' } });
    for (const conn of conns) {
      const cp = await this.core.deps.prisma.syncCheckpoint.findUnique({ where: { connectionId_stream: { connectionId: conn.id, stream: 'leads' } } });
      const startedAt = new Date();
      const since = new Date(((cp?.cursor as { since?: string } | null)?.since ? Date.parse((cp!.cursor as { since: string }).since) : startedAt.getTime() - 24 * 3600_000) - 10 * 60_000);
      const client = this.core.deps.adapters.amoRest(conn);
      let page = 1;
      let applied = 0;
      let seen = 0;
      for (;;) {
        const r = await client.listLeadsUpdatedSince(since, page, 250);
        for (const snap of r.items) {
          seen++;
          const res = await this.core.deps.prisma.$transaction((tx) => this.core.leads.applyRemoteSnapshot(tx, conn.companyId, snap, { origin: 'reconcile' }));
          if (res.applied) applied++;
        }
        if (!r.hasMore || page >= 200) break;
        page++;
      }
      await this.core.deps.prisma.syncCheckpoint.upsert({
        where: { connectionId_stream: { connectionId: conn.id, stream: 'leads' } },
        create: { companyId: conn.companyId, connectionId: conn.id, stream: 'leads', cursor: { since: startedAt.toISOString() }, lastRunAt: startedAt, lastResult: { seen, applied } },
        update: { cursor: { since: startedAt.toISOString() }, lastRunAt: startedAt, lastResult: { seen, applied } },
      });
      await this.core.deps.prisma.integrationConnection.update({ where: { id: conn.id }, data: { lastSyncAt: startedAt } });
    }
  }

  async stop() {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    await Promise.allSettled(this.workers.map((w) => w.close()));
    await Promise.allSettled(this.queues.map((q) => q.close()));
  }
}
