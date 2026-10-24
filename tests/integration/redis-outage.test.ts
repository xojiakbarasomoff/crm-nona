import type { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { WorkerRuntime } from '../../apps/worker/src/runtime';
import { drain, makeApp, makeCore, sendLeadAds } from './helpers';

let core: Core;
let app: INestApplication;

beforeAll(async () => {
  core = makeCore();
  app = await makeApp(core);
});
afterAll(async () => {
  await app.close();
  await core.close();
});

describe('Redis outage (AC25, TZ §14.4 / §19.1)', () => {
  it('relay failure leaves work pending in PostgreSQL; nothing is lost and it is processed after recovery', async () => {
    const { res, leadgenId } = await sendLeadAds(app, core, { fullName: 'Redis Down', phone: '+998939990001', platform: 'ig' });
    expect(res.status).toBe(200); // durable ACK does not depend on Redis

    const dead = { host: '127.0.0.1', port: 1, maxRetriesPerRequest: 1, enableOfflineQueue: false, retryStrategy: () => null };
    const inboxQ = new Queue('inbox-outage-test', { connection: dead });
    const outboxQ = new Queue('outbox-outage-test', { connection: dead });
    inboxQ.on('error', () => undefined);
    outboxQ.on('error', () => undefined);
    const runtime = new WorkerRuntime(core, dead as never);
    await expect(runtime.relay(outboxQ, inboxQ)).resolves.toBeUndefined(); // logged, not thrown
    const row = await core.deps.prisma.webhookInbox.findFirstOrThrow({ where: { externalEventId: `leadgen:${leadgenId}` } });
    expect(row.state).toBe('pending');
    await Promise.allSettled([inboxQ.close(), outboxQ.close()]);

    // Scheduler is DB-driven and keeps working without Redis transport.
    expect(await core.reminders.claimDue('outage-worker', 10)).toBeInstanceOf(Array);

    // "Redis is back": the same rows are processed exactly once.
    await drain(core);
    expect(await core.deps.prisma.inquiry.count({ where: { providerEventKey: `meta_leads:${leadgenId}` } })).toBe(1);
    expect((await core.deps.prisma.webhookInbox.findUniqueOrThrow({ where: { id: row.id } })).state).toBe('done');
  });
});
