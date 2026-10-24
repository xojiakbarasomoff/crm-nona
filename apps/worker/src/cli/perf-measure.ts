/**
 * Measures API latency with 20 concurrent clients (TZ §22.1) against a running API.
 *   API_URL=http://localhost:4100 npm run perf:measure -- --requests=200
 * Logs in as the demo head (rahbar@demo.local) — demo/perf databases only.
 */
const API = process.env.API_URL ?? 'http://localhost:4100';
const total = Number(process.argv.find((a) => a.startsWith('--requests='))?.split('=')[1] ?? '200');

async function login() {
  const r = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'rahbar@demo.local', password: 'Demo-parol-2026!' }) });
  if (!r.ok) throw new Error(`login ${r.status}`);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

function pct(xs: number[], q: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
}

async function bench(cookie: string, path: string, concurrency = 20) {
  const times: number[] = [];
  let errors = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < total) {
        next++;
        const t = performance.now();
        const r = await fetch(`${API}${path}`, { headers: { cookie } });
        await r.arrayBuffer();
        if (!r.ok) errors++;
        times.push(performance.now() - t);
      }
    }),
  );
  return { path, concurrency, requests: times.length, errors, p50: Math.round(pct(times, 0.5)), p95: Math.round(pct(times, 0.95)), max: Math.round(Math.max(...times)) };
}

async function benchDynamic(cookie: string, pathFn: () => string, concurrency: number, n: number, label: string) {
  const times: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = performance.now();
    const r = await fetch(`${API}${pathFn()}`, { headers: { cookie } });
    await r.arrayBuffer();
    times.push(performance.now() - t);
  }
  return { path: label, concurrency, requests: n, errors: 0, p50: Math.round(pct(times, 0.5)), p95: Math.round(pct(times, 0.95)), max: Math.round(Math.max(...times)) };
}

async function main() {
  const cookie = await login();
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const results = [];
  for (const path of ['/api/v1/leads?limit=50', '/api/v1/orders?limit=50', '/api/v1/flights?limit=50&filter=7d']) results.push(await bench(cookie, path));
  // Dashboard: distinct filters per request defeat the 20 s cache → uncached latency, 1 and 20 clients.
  let i = 0;
  const uncached = () => `/api/v1/dashboard?from=${monthAgo}&to=${today}&bucket=${['day', 'week', 'month'][i++ % 3]}&source=${['instagram_lead_ads', 'meta_lead_ads', 'instagram_direct'][Math.floor(i / 3) % 3]}`;
  results.push(await benchDynamic(cookie, uncached, 1, 20, 'dashboard (uncached, 1 client)'));
  results.push(await bench(cookie, `/api/v1/dashboard?from=${monthAgo}&to=${today}`, 20));
  console.table(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
