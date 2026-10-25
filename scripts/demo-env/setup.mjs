// Alohida demo bazani yaratadi (`crm_finance_demo`), migratsiyalarni qo'llaydi (migrate deploy) va demo seed'ni yuklaydi.
// Asosiy `crm` bazasiga TEGILMAYDI; mavjud demo bazani o'chirmaydi (faqat yetishmaganini yaratadi).
import { execSync } from 'node:child_process';
import pg from 'pg';
import { DEMO_DB, demoEnv, root } from './common.mjs';

const { adminUrl, env } = demoEnv();
const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
const exists = (await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DEMO_DB])).rowCount > 0;
if (!exists) {
  await client.query(`CREATE DATABASE "${DEMO_DB}"`);
  console.log(`baza yaratildi: ${DEMO_DB}`);
} else {
  console.log(`baza mavjud: ${DEMO_DB} (o'chirilmaydi, faqat yetishmagan migratsiyalar qo'llanadi)`);
}
await client.end();

execSync('npx prisma migrate deploy', { cwd: root, env, stdio: 'inherit' });
execSync('npx tsx --conditions=development packages/database/src/seed.ts', { cwd: root, env, stdio: 'inherit' });
console.log('\nTayyor. Ishga tushirish: npm run demo:finance:start');
console.log('Sun’iy demo ma’lumotlarni qo‘shish (xohlasangiz): npm run demo:finance:data');
