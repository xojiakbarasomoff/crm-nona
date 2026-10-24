/**
 * Samples inbox/outbox backlog every N seconds during a load test and writes JSON lines.
 * Stops when --until-drained and no pending work remains (after --min-seconds).
 *   DATABASE_URL=... npm run perf:monitor -- --interval=30 --min-seconds=900 --out=docs/perf/run.jsonl --until-drained
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPrisma } from '@crm/database';

const arg = (n: string, d: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const interval = Number(arg('interval', '30')) * 1000;
const minSeconds = Number(arg('min-seconds', '900'));
const out = arg('out', 'docs/perf/monitor.jsonl');
const untilDrained = process.argv.includes('--until-drained');
const prefix = arg('prefix', 'ig_msg:perf-');
const since = new Date(arg('since', new Date().toISOString()));

async function main() {
  mkdirSync(dirname(out), { recursive: true });
  const prisma = createPrisma();
  const started = Date.now();
  try {
    for (;;) {
      const inbox = await prisma.$queryRawUnsafe<Array<{ state: string; n: bigint }>>(`SELECT state::text, count(*)::bigint AS n FROM webhook_inbox WHERE external_event_id LIKE $1 AND received_at >= $2 GROUP BY state`, `${prefix}%`, since);
      const outbox = await prisma.$queryRawUnsafe<Array<{ state: string; n: bigint }>>(`SELECT state::text, count(*)::bigint AS n FROM outbox_operations WHERE created_at >= $1 GROUP BY state`, new Date(started - 60_000));
      const lag = await prisma.$queryRawUnsafe<Array<{ s: number | null }>>(`SELECT EXTRACT(EPOCH FROM now() - min(received_at))::float AS s FROM webhook_inbox WHERE state IN ('pending','processing','failed') AND external_event_id LIKE $1 AND received_at >= $2`, `${prefix}%`, since);
      const done = await prisma.$queryRawUnsafe<Array<{ p50: number | null; p95: number | null }>>(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM processed_at - received_at))::float AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM processed_at - received_at))::float AS p95
         FROM webhook_inbox WHERE processed_at IS NOT NULL AND external_event_id LIKE $1 AND received_at >= $2`,
        `${prefix}%`,
        since,
      );
      const row = {
        t: Math.round((Date.now() - started) / 1000),
        inbox: Object.fromEntries(inbox.map((r) => [r.state, Number(r.n)])),
        outbox: Object.fromEntries(outbox.map((r) => [r.state, Number(r.n)])),
        oldestPendingSec: lag[0]?.s ? Math.round(lag[0].s) : 0,
        processingLagSec: { p50: done[0]?.p50 ?? null, p95: done[0]?.p95 ?? null },
      };
      appendFileSync(out, `${JSON.stringify(row)}\n`);
      console.log(JSON.stringify(row));
      const pending = (row.inbox.pending ?? 0) + (row.inbox.processing ?? 0) + (row.inbox.failed ?? 0) + (row.outbox.pending ?? 0) + (row.outbox.processing ?? 0);
      if ((Date.now() - started) / 1000 >= minSeconds && (!untilDrained || pending === 0)) break;
      await new Promise((r) => setTimeout(r, interval));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
