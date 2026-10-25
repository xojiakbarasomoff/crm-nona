import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, loadConfig, type Core, type UserActor } from '../../apps/api/src/core';
import { createPrisma } from '../../packages/database/src';

/**
 * Migratsiya isboti: eski sxemadagi (xususiyatdan OLDINGI) ma'lumotlar bilan to'ldirilgan VAQTINCHALIK bazada
 * yangi migratsiyalar qo'llanadi va eski buyurtmalar, xizmatlar, to'lovlar, hujjatlar va summalar o'zgarmasligi
 * tekshiriladi. Foydalanuvchining `crm` bazasiga TEGILMAYDI: baza `crm_mig_<vaqt>` nomi bilan yaratiladi va
 * faqat shu nomli baza o'chiriladi. `prisma migrate reset` ishlatilmaydi — faqat `migrate deploy`.
 */
const root = join(__dirname, '..', '..');
process.loadEnvFile?.(join(root, '.env'));
const base = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const dbName = `crm_mig_${Date.now()}`;

const migrationsDir = join(root, 'packages', 'database', 'prisma', 'migrations');
const all = readdirSync(migrationsDir).filter((d) => /^\d{14}_/.test(d)).sort();
/** Xususiyatdan oldingi sxema = 20261024* migratsiyalari. */
const legacy = all.filter((d) => d.startsWith('20261024'));
const featureOne = all.filter((d) => d.startsWith('20261025000000'));
const featureTwo = all.filter((d) => d.startsWith('20261025000100'));

let adminDb: ReturnType<typeof createPrisma>;
let db: ReturnType<typeof createPrisma>;
let dbUrl: string;
let tmp: string;
let core: Core | undefined;

function deploy(folders: string[]) {
  // Prisma migrate deploy faqat shu vaqtinchalik papkadagi migratsiyalarni ko'radi (qolganlari keyingi bosqichda qo'shiladi).
  mkdirSync(join(tmp, 'migrations'), { recursive: true });
  for (const f of folders) cpSync(join(migrationsDir, f), join(tmp, 'migrations', f), { recursive: true });
  cpSync(join(migrationsDir, 'migration_lock.toml'), join(tmp, 'migrations', 'migration_lock.toml'));
  const cfg = join(root, `prisma.migcheck.${dbName}.config.ts`);
  writeFileSync(
    cfg,
    `import { defineConfig } from 'prisma/config';\nexport default defineConfig({ schema: ${JSON.stringify(join(root, 'packages/database/prisma/schema.prisma'))}, migrations: { path: ${JSON.stringify(join(tmp, 'migrations'))} }, datasource: { url: ${JSON.stringify(dbUrl)} } });\n`,
  );
  try {
    execSync(`npx prisma migrate deploy --config ${JSON.stringify(cfg)}`, { cwd: root, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' });
  } finally {
    rmSync(cfg, { force: true });
  }
}

const q = async <T = Record<string, unknown>>(sql: string): Promise<T[]> => (await db.$queryRawUnsafe(sql)) as T[];
const x = async (sql: string) => db.$executeRawUnsafe(sql).catch((e: { message?: string; meta?: unknown }) => { throw new Error(`SQL xato: ${sql.slice(0, 80)}… -> ${e.message} ${JSON.stringify(e.meta ?? {}, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`); });

const C = '10000000-0000-4000-8000-000000000001';
const HEAD = '10000000-0000-4000-8000-0000000000a1';
const MGR = '10000000-0000-4000-8000-0000000000a2';
const CONTACT = '10000000-0000-4000-8000-0000000000c1';
const LEAD1 = '10000000-0000-4000-8000-0000000000b1';
const LEAD2 = '10000000-0000-4000-8000-0000000000b2';
const O1 = '10000000-0000-4000-8000-0000000000d1';
const O2 = '10000000-0000-4000-8000-0000000000d2';
const O3 = '10000000-0000-4000-8000-0000000000d3';
const OP = '10000000-0000-4000-8000-0000000000e1';

/** Jadval -> eski ustunlar (migratsiyadan oldin o'qiladi) va ularning kontrol yig'indisi. */
const watched = ['companies', 'users', 'contacts', 'leads', 'orders', 'order_services', 'passengers', 'payments', 'attachments', 'audit_logs', 'order_sequences'];
const legacyCols: Record<string, string[]> = {};
const before: Record<string, { count: number; digest: string }> = {};

async function digest(table: string, cols: string[]) {
  const list = cols.map((c) => `"${c}"`).join(', ');
  const r = await q<{ count: bigint; digest: string | null }>(
    `SELECT count(*)::bigint AS count, md5(coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY row_to_json(t)::text), '')) AS digest FROM (SELECT ${list} FROM "${table}") t`,
  );
  return { count: Number(r[0]!.count), digest: r[0]!.digest! };
}

beforeAll(async () => {
  if (!base || !redisUrl) throw new Error('TEST_DATABASE_URL va TEST_REDIS_URL kerak (.env.example)');
  const u = new URL(base);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('Migratsiya tekshiruvi faqat lokal bazada ishlaydi');
  u.pathname = `/${dbName}`;
  dbUrl = u.toString();
  tmp = mkdtempSync(join(tmpdir(), 'mig-'));
  adminDb = createPrisma(base);
  await adminDb.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  db = createPrisma(dbUrl);
});

afterAll(async () => {
  await core?.close();
  await db?.$disconnect();
  if (process.env.KEEP_TEST_DB !== '1') await adminDb?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await adminDb?.$disconnect();
  rmSync(tmp, { recursive: true, force: true });
});

describe('eski sxemadan yangisiga migratsiya (vaqtinchalik baza)', () => {
  it('1. eski sxema (xususiyatdan oldingi migratsiyalar) qo‘llanadi va unda yangi ob’ektlar yo‘q', async () => {
    deploy(legacy);
    const tables = (await q<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)).map((t) => t.table_name);
    expect(tables).not.toContain('suppliers');
    expect(tables).not.toContain('supplier_refunds');
    const orderCols = (await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='orders'`)).map((c) => c.column_name);
    expect(orderCols).not.toContain('net_price_minor');
    expect(orderCols).not.toContain('tour_operator_id');
  });

  it('2. eski sxemadagi haqiqiy ko‘rinishdagi ma’lumotlar kiritiladi (buyurtmalar, xizmatlar, to‘lovlar, hujjatlar, audit)', async () => {
    await x(`INSERT INTO companies (id, name, work_schedule, updated_at) VALUES ('${C}', 'Eski kompaniya', '{}'::jsonb, now())`);
    await x(`INSERT INTO users (id, company_id, email, full_name, role, updated_at) VALUES
      ('${HEAD}', '${C}', 'rahbar@legacy.test', 'Eski Rahbar', 'HEAD', now()),
      ('${MGR}', '${C}', 'menejer@legacy.test', 'Eski Menejer', 'MANAGER', now())`);
    await x(`INSERT INTO contacts (id, company_id, updated_at) VALUES ('${CONTACT}', '${C}', now())`);
    await x(`INSERT INTO leads (id, company_id, contact_id, name, first_source, updated_at, owner_id, stage) VALUES
      ('${LEAD1}', '${C}', '${CONTACT}', 'Eski lid 1', 'manual', now(), '${MGR}', 'WON'),
      ('${LEAD2}', '${C}', '${CONTACT}', 'Eski lid 2', 'manual', now(), '${MGR}', 'AWAITING_PAYMENT')`);
    // O1: tasdiqlangan, 12 345,67 USD kelishilgan; O2: valyutasiz, summasiz qoralama; O3: EUR, bekor qilingan
    await x(`INSERT INTO orders (id, company_id, order_no, lead_id, contact_id, owner_id, agreed_amount_minor, currency, fulfillment_state, payment_state, confirmed_at, sale_evidence, updated_at) VALUES
      ('${O1}', '${C}', 'ORD-2026-000001', '${LEAD1}', '${CONTACT}', '${MGR}', 1234567, 'USD', 'confirmed', 'partial', now(), 'manager_confirmed', now()),
      ('${O2}', '${C}', 'ORD-2026-000002', '${LEAD2}', '${CONTACT}', '${MGR}', NULL, NULL, 'draft', 'unpaid', NULL, NULL, now()),
      ('${O3}', '${C}', 'ORD-2026-000003', '${LEAD1}', '${CONTACT}', '${MGR}', 99900, 'EUR', 'cancelled', 'refunded', now(), 'manager_confirmed', now())`);
    await x(`UPDATE orders SET cancelled_at = now() WHERE id = '${O3}'`);
    // Eski xizmat qatorlari; ulardan biri summasiz va valyutasiz (eski sxema buni ruxsat etgan).
    await x(`INSERT INTO order_services (id, company_id, order_id, service_type, description, amount_minor, currency) VALUES
      ('20000000-0000-4000-8000-000000000001', '${C}', '${O1}', 'hotel', 'Eski mehmonxona', 800000, 'USD'),
      ('20000000-0000-4000-8000-000000000002', '${C}', '${O1}', 'visa', 'Eski viza', 34567, 'USD'),
      ('20000000-0000-4000-8000-000000000003', '${C}', '${O1}', 'other', 'Eski summasiz qator', NULL, NULL)`);
    await x(`INSERT INTO passengers (id, company_id, order_id, full_name, updated_at) VALUES ('30000000-0000-4000-8000-000000000001', '${C}', '${O1}', 'Eski Yo''lovchi', now())`);
    await x(`INSERT INTO payments (id, company_id, order_id, kind, amount_minor, currency, received_at, method, business_key, recorded_by_id) VALUES
      ('40000000-0000-4000-8000-000000000001', '${C}', '${O1}', 'payment', 1000000, 'USD', now(), 'cash', 'legacy-p-1', '${MGR}'),
      ('40000000-0000-4000-8000-000000000002', '${C}', '${O1}', 'refund', 50000, 'USD', now(), 'cash', 'legacy-r-1', '${MGR}'),
      ('40000000-0000-4000-8000-000000000003', '${C}', '${O3}', 'payment', 99900, 'EUR', now(), 'card', 'legacy-p-3', '${MGR}'),
      ('40000000-0000-4000-8000-000000000004', '${C}', '${O3}', 'refund', 99900, 'EUR', now(), 'card', 'legacy-r-3', '${MGR}')`);
    await x(`INSERT INTO attachments (id, company_id, owner_type, owner_id, object_key, file_name, mime, size, uploaded_by_id, sha256, scan_state) VALUES
      ('50000000-0000-4000-8000-000000000001', '${C}', 'order', '${O1}', 'legacy/contract.pdf', 'shartnoma.pdf', 'application/pdf', 52000, '${MGR}', '${'a'.repeat(64)}', 'clean'),
      ('50000000-0000-4000-8000-000000000002', '${C}', 'order', '${O1}', 'legacy/scan.png', 'pasport.png', 'image/png', 12000, '${MGR}', '${'b'.repeat(64)}', 'pending')`);
    await x(`INSERT INTO audit_logs (id, company_id, actor_type, entity_type, entity_id, action, correlation_id) VALUES
      ('60000000-0000-4000-8000-000000000001', '${C}', 'user', 'order', '${O1}', 'order_created', 'legacy-1'),
      ('60000000-0000-4000-8000-000000000002', '${C}', 'user', 'order', '${O1}', 'payment_recorded', 'legacy-2')`);
    await x(`INSERT INTO order_sequences (company_id, year, last_value) VALUES ('${C}', 2026, 3)`);

    for (const t of watched) {
      legacyCols[t] = (await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}' ORDER BY ordinal_position`)).map((c) => c.column_name);
      before[t] = await digest(t, legacyCols[t]!);
    }
    expect(before.orders!.count).toBe(3);
    expect(before.order_services!.count).toBe(3);
    expect(before.attachments!.count).toBe(2);
  });

  it('3. yangi migratsiyalar qo‘llanadi (non-destructive migrate deploy); oraliqda lid operatori bilan ishlangan holat ham modellashtiriladi', async () => {
    deploy([...legacy, ...featureOne]);
    // Birinchi xususiyat migratsiyasidan keyin foydalanuvchi lidga turoperator tanlagan bo'lishi mumkin (hozirgi lokal baza holati).
    await x(`INSERT INTO suppliers (id, company_id, name, kind) VALUES ('${OP}', '${C}', 'Tanlangan turoperator', 'tour_operator')`);
    await x(`UPDATE leads SET tour_operator_id = '${OP}' WHERE id = '${LEAD1}'`);
    deploy([...legacy, ...featureOne, ...featureTwo]);
    const applied = await q<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>(`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`);
    expect(applied.map((a) => a.migration_name)).toEqual([...legacy, ...featureOne, ...featureTwo]);
    expect(applied.every((a) => a.finished_at && !a.rolled_back_at)).toBe(true);
  });

  it('4. eski ustunlardagi barcha qatorlar bayt-bayt o‘zgarmagan (soni va kontrol yig‘indisi teng)', async () => {
    for (const t of watched) {
      const after = await digest(t, legacyCols[t]!);
      expect(after, `${t} jadvali`).toEqual(before[t]);
    }
  });

  it('5. summalar, to‘lovlar va hujjatlar aynan saqlangan', async () => {
    const orders = await q<{ id: string; agreed_amount_minor: bigint | null; currency: string | null; fulfillment_state: string; payment_state: string }>(`SELECT id, agreed_amount_minor, currency, fulfillment_state, payment_state FROM orders ORDER BY order_no`);
    expect(orders.map((o) => [o.agreed_amount_minor === null ? null : Number(o.agreed_amount_minor), o.currency, o.fulfillment_state, o.payment_state])).toEqual([
      [1234567, 'USD', 'confirmed', 'partial'],
      [null, null, 'draft', 'unpaid'],
      [99900, 'EUR', 'cancelled', 'refunded'],
    ]);
    const services = await q<{ amount_minor: bigint | null }>(`SELECT amount_minor FROM order_services WHERE order_id='${O1}' ORDER BY amount_minor NULLS FIRST`);
    expect(services.map((s) => (s.amount_minor === null ? null : Number(s.amount_minor)))).toEqual([null, 34567, 800000]); // summasiz qator 0 ga aylanmagan
    const pay = await q<{ kind: string; total: bigint }>(`SELECT kind, sum(amount_minor)::bigint AS total FROM payments GROUP BY kind ORDER BY kind`);
    expect(pay.map((p) => [p.kind, Number(p.total)])).toEqual([['payment', 1099900], ['refund', 149900]]);
    const files = await q<{ file_name: string; sha256: string; scan_state: string; size: number }>(`SELECT file_name, sha256, scan_state, size FROM attachments ORDER BY file_name`);
    expect(files).toEqual([
      { file_name: 'pasport.png', sha256: 'b'.repeat(64), scan_state: 'pending', size: 12000 },
      { file_name: 'shartnoma.pdf', sha256: 'a'.repeat(64), scan_state: 'clean', size: 52000 },
    ]);
    expect(Number((await q<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM audit_logs`))[0]!.c)).toBe(2);
  });

  it('6. yangi ustunlar xavfsiz boshlang‘ich qiymat oladi: tannarx NULL (0 emas), hujjat kategoriyasi «other», qaytarimlar bo‘sh', async () => {
    expect((await q<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM orders WHERE net_price_minor IS NOT NULL`))[0]!.c).toBe(0n);
    expect((await q<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM order_services WHERE net_minor IS NOT NULL OR supplier_id IS NOT NULL OR removed_at IS NOT NULL`))[0]!.c).toBe(0n);
    expect((await q<{ category: string }>(`SELECT DISTINCT category FROM attachments`)).map((a) => a.category)).toEqual(['other']);
    expect((await q<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM supplier_refunds`))[0]!.c).toBe(0n);
    expect((await q<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM users WHERE cardinality(extra_capabilities) > 0`))[0]!.c).toBe(0n);
  });

  it('7. buyurtma turoperatori migratsiya paytidagi lid tanlovidan tiklangan (tarixiy tasdiqlanmagan backfill), tanlovsiz buyurtma NULL; sun’iy ma’lumot qo‘shilmagan', async () => {
    const ops = await q<{ id: string; tour_operator_id: string | null }>(`SELECT id, tour_operator_id FROM orders ORDER BY order_no`);
    expect(ops.map((o) => o.tour_operator_id)).toEqual([OP, null, OP]); // O1 va O3 — LEAD1; O2 — LEAD2 (tanlovsiz)
    // migratsiyalar faqat testning o'zi qo'ygan 1 ta turoperatorni biladi; hech qanday sintetik narx/turoperator yaratilmagan
    expect((await q<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM suppliers`))[0]!.c).toBe(1n);
    expect((await q<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM orders`))[0]!.c).toBe(3n);
    expect((await q<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM order_services`))[0]!.c).toBe(3n);
  });

  it('8. yangi CHECK cheklovlar eski qatorlarni rad etmaydi, lekin yangi noto‘g‘ri qiymatni rad etadi', async () => {
    // eski qatorni (tannarxsiz) boshqa maydon bo'yicha yangilash mumkin: yangi CHECK uni qayta tekshirmaydi (NOT VALID)
    await expect(x(`UPDATE orders SET note = 'eski izoh' WHERE id = '${O2}'`)).resolves.toBeDefined();
    // yangi qiymatlar tekshiriladi: manfiy tannarx va valyutasiz tannarx rad etiladi
    await expect(x(`UPDATE orders SET net_price_minor = -1 WHERE id = '${O1}'`)).rejects.toThrow();
    await expect(x(`UPDATE orders SET net_price_minor = 100 WHERE id = '${O2}'`)).rejects.toThrow(); // O2 valyutasiz
    await expect(x(`UPDATE users SET extra_capabilities = ARRAY['admin.everything'] WHERE id = '${MGR}'`)).rejects.toThrow();
    await expect(x(`UPDATE users SET extra_capabilities = ARRAY['finance.cost.view'] WHERE id = '${MGR}'`)).resolves.toBeDefined();
    await x(`UPDATE users SET extra_capabilities = '{}' WHERE id = '${MGR}'`);
  });

  it('9. yangi dastur eski buyurtmani o‘qiydi: sotuv summasi saqlangan, foyda «aniqlanmagan» (0 emas), tannarx yo‘q', async () => {
    // Yangi dastur har doim barcha migratsiyalar qo'llangandan keyin ishga tushadi (backend-start: migrate deploy → start).
    deploy(all);
    expect((await q<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM orders`))[0]!.n).toBe(3n);
    const config = loadConfig({
      ...process.env,
      APP_MODE: 'demo',
      DATABASE_URL: dbUrl,
      REDIS_URL: redisUrl!,
      LOG_LEVEL: 'silent',
      COOKIE_SECURE: 'false',
    });
    core = createCore(config);
    const head: UserActor = { type: 'user', id: HEAD, companyId: C, role: 'ADMIN', email: 'rahbar@legacy.test' };
    const card = await core.orders.getOrder(head, O1);
    expect(card.canCost).toBe(true);
    const usd = card.finance.byCurrency.USD as Record<string, unknown>;
    // 12 345,67 USD sotuv (paket) + xizmatlar paketga kiritilmagan bo'lsa ham eski qiymatlar o'zgarmaydi
    expect(usd.selling).toBeDefined();
    expect(usd.profit).toBeNull(); // tannarx noma'lum -> foyda aniqlanmagan
    expect(usd.profitState).toBe('undetermined');
    expect(usd.net).toBeNull();
    expect(card.supplierRefunds).toEqual([]);
    expect(card.order.tourOperatorId).toBe(OP);
    // menejer (huquqsiz) uchun hech narsa ochilmaydi
    const mgr: UserActor = { type: 'user', id: MGR, companyId: C, role: 'MANAGER', email: 'menejer@legacy.test' };
    const mc = await core.orders.getOrder(mgr, O1);
    expect(mc.canCost).toBe(false);
    expect(mc.finance.byCurrency.USD).not.toHaveProperty('profit');
  });

  it('10. rollar migratsiyasi: HEAD → MANAGER, zaxira jadvali eski rolni saqlaydi, `login` ustuni qo‘shilgan, hech bir foydalanuvchi o‘chirilmagan', async () => {
    const usersBefore = await q<{ id: string }>(`SELECT id FROM users ORDER BY id`);
    deploy(all);
    const users = await q<{ id: string; role: string }>(`SELECT id, role::text AS role FROM users ORDER BY id`);
    expect(users.map((u) => u.id)).toEqual(usersBefore.map((u) => u.id));
    expect(users.find((u) => u.id === HEAD)!.role).toBe('MANAGER');
    expect(users.find((u) => u.id === MGR)!.role).toBe('MANAGER');
    const backup = await q<{ id: string; role: string }>(`SELECT id, role FROM "_backup_users_role_20261026" ORDER BY id`);
    expect(backup.find((u) => u.id === HEAD)!.role).toBe('HEAD');
    expect((await q<{ v: string }>(`SELECT unnest(enum_range(NULL::"Role"))::text AS v`)).map((e) => e.v)).toEqual(['ADMIN', 'MANAGER', 'USER']);
    expect((await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='login'`)).length).toBe(1);
    // tarixiy audit va buyurtmalar saqlangan
    expect((await q<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM audit_logs`))[0]!.n).toBeGreaterThanOrEqual(2n);
    expect((await q<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM orders`))[0]!.n).toBe(3n);
  });
});
