// Alohida DEMO muhit (finance demo): foydalanuvchining asosiy `crm` bazasi va Railway'dan butunlay ajratilgan.
// Hamma skriptlar shu yerdagi qo'riqchidan o'tadi: faqat lokal xost, faqat `crm_finance_demo` bazasi.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEMO_DB = 'crm_finance_demo';
export const DEMO_API_PORT = 4101;
export const DEMO_WEB_PORT = 3101;
export const DEMO_REDIS_DB = 7;

/** .env dan faqat parolsiz qismlarni (host/port) oladi; asosiy baza nomi o'zgarmaydi. */
function readEnv() {
  const out = {};
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* .env yo'q — standart lokal qiymatlar */
  }
  return out;
}

export function demoEnv() {
  const base = process.env.DATABASE_URL ?? readEnv().DATABASE_URL ?? 'postgresql://crm:crm_local_only@127.0.0.1:55432/crm';
  const redisBase = (process.env.REDIS_URL ?? readEnv().REDIS_URL ?? 'redis://127.0.0.1:56379').replace(/\/\d+$/, '');
  const dbUrl = new URL(base);
  const adminUrl = new URL(base);
  adminUrl.pathname = '/postgres';
  dbUrl.pathname = `/${DEMO_DB}`;
  const redisUrl = `${redisBase}/${DEMO_REDIS_DB}`;
  assertLocal(dbUrl.hostname, 'PostgreSQL');
  assertLocal(new URL(redisUrl).hostname, 'Redis');
  return {
    dbUrl: dbUrl.toString(),
    adminUrl: adminUrl.toString(),
    redisUrl,
    env: {
      ...readEnv(), // sirlar (ENCRYPTION_KEY...) .env dan; quyidagi demo qiymatlari ularni bosib o'tadi
      ...process.env,
      APP_MODE: 'demo',
      DEMO_SIMPLE_LOGIN: 'false',
      DATABASE_URL: dbUrl.toString(),
      REDIS_URL: redisUrl,
      API_PORT: String(DEMO_API_PORT),
      APP_PUBLIC_URL: `http://localhost:${DEMO_WEB_PORT}`,
      API_PUBLIC_URL: `http://localhost:${DEMO_API_PORT}`,
      API_INTERNAL_URL: `http://127.0.0.1:${DEMO_API_PORT}`,
      STORAGE_LOCAL_DIR: join(root, 'storage-demo'),
      NEXT_DIST_DIR: '.next-demo',
    },
  };
}

export function assertLocal(host, what) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error(`${what} xosti lokal emas (${host}). Demo muhit faqat lokal mashinada ishlaydi; Railway/production'ga tegilmaydi.`);
}
