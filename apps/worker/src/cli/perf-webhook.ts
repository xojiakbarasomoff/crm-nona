/**
 * Webhook durable-ACK load test (TZ §22.1): sends signed Meta Direct events at a fixed rate and
 * reports ACK latency percentiles. Count stored rows afterwards to confirm no durable loss.
 *   API_URL=http://localhost:4200 npm run perf:webhook -- --rate=10 --seconds=60
 */
import { createHmac, randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:4100';
const secret = process.env.META_APP_SECRET ?? '';
const rate = Number(process.argv.find((a) => a.startsWith('--rate='))?.split('=')[1] ?? '10');
const seconds = Number(process.argv.find((a) => a.startsWith('--seconds='))?.split('=')[1] ?? '60');
const account = process.env.PERF_IG_ACCOUNT ?? '17840000000000001';

async function main() {
  const runId = randomUUID().slice(0, 8);
  const times: number[] = [];
  let failed = 0;
  const pending: Promise<void>[] = [];
  for (let i = 0; i < rate * seconds; i++) {
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: account, time: Date.now(), messaging: [{ sender: { id: `perf-wh-${runId}-${i % 500}` }, recipient: { id: account }, timestamp: Date.now(), message: { mid: `perf-${runId}-${i}`, text: `load ${i}` } }] }] });
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const t = performance.now();
    pending.push(
      fetch(`${API}/webhooks/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body })
        .then(async (r) => {
          await r.arrayBuffer();
          if (!r.ok) failed++;
          times.push(performance.now() - t);
        })
        .catch(() => {
          failed++;
        }),
    );
    await new Promise((r) => setTimeout(r, 1000 / rate));
  }
  await Promise.all(pending);
  const s = [...times].sort((a, b) => a - b);
  const p = (q: number) => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0);
  console.log(JSON.stringify({ runId, sent: rate * seconds, acked: times.length - failed, failed, p50: p(0.5), p95: p(0.95), max: Math.round(s[s.length - 1] ?? 0), externalIdPrefix: `ig_msg:perf-${runId}-` }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
