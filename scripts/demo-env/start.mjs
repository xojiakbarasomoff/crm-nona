// Alohida demo muhitni ishga tushiradi: API :4101, worker, web :3101 (o'z Redis DB, saqlash papkasi va .next-demo).
// Asosiy dev muhit (:4100/:3100, `crm` bazasi) bilan parallel ishlaydi va uni buzmaydi.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { DEMO_API_PORT, DEMO_WEB_PORT, demoEnv, root } from './common.mjs';

const { env } = demoEnv();
const run = (name, cmd, cwd) => {
  const p = spawn(cmd, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on('data', tag);
  p.stderr.on('data', tag);
  p.on('exit', (c) => console.log(`[${name}] to'xtadi (${c})`));
  return p;
};
const procs = [
  run('demo-api', 'npm run dev -w @crm/api', root),
  run('demo-worker', 'npm run dev -w @crm/worker', root),
  run('demo-web', `npx next dev -p ${DEMO_WEB_PORT}`, join(root, 'apps', 'web')),
];
console.log(`Demo muhit: web http://localhost:${DEMO_WEB_PORT}  ·  API http://localhost:${DEMO_API_PORT}  ·  baza crm_finance_demo`);
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
