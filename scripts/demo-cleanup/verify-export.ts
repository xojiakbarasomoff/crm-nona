import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPrisma } from '../../packages/database/src';

/**
 * Mantiqiy eksportni ALOHIDA vaqtinchalik bazaga tiklab tekshiradi (mavjud bazalarga tegmaydi).
 *   npx tsx --conditions=development scripts/demo-cleanup/verify-export.ts <eksport.json>
 * Talab: TEST_DATABASE_URL (lokal PostgreSQL). Vaqtinchalik baza (crm_restore_<vaqt>) yaratiladi, migratsiyalar `migrate deploy` bilan
 * qo'llanadi, eksport teskari tartibda tiklanadi, har jadvalning qatorlari eksport bilan baytma-bayt solishtiriladi va baza o'chiriladi.
 * Ota-jadvallar (xodim, kompaniya...) vaqtinchalik bazada yo'q, shuning uchun FK tekshiruvi tiklash tranzaksiyasida o'chiriladi
 * (session_replication_role=replica); tashqi bog'liqliklar esa eksportdagi `integrity` bo'limi bilan (ishlab chiqarish bazasiga qarshi) tekshiriladi.
 */
export interface ExportFile {
  format: string;
  manifestHash: string;
  counts: Record<string, number>;
  integrity?: Record<string, { referenced: number; missing: string[] }>;
  tables: Array<{ table: string; count: number; rows: Array<Record<string, unknown>> }>;
}

const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v);
const canonRows = (rows: unknown[]) => rows.map((r) => JSON.stringify(canon(r))).sort();

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  tables: Array<{ table: string; exported: number; restored: number; identical: boolean }>;
  integrityMissing: Record<string, string[]>;
  database: string;
}

export async function restoreAndVerify(exp: ExportFile, baseUrl: string, root = join(__dirname, '..', '..')): Promise<VerifyResult> {
  const name = `crm_restore_${Date.now()}`;
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const dbUrl = url.toString();
  const admin = createPrisma(baseUrl);
  const problems: string[] = [];
  const tables: VerifyResult['tables'] = [];
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  let db: ReturnType<typeof createPrisma> | null = null;
  try {
    execSync('npx prisma migrate deploy', { cwd: root, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' });
    db = createPrisma(dbUrl);
    if (exp.format !== 'crm-demo-cleanup-export/1') problems.push(`noma'lum format: ${exp.format}`);
    for (const t of exp.tables) if (t.rows.length !== t.count || (exp.counts[t.table] ?? -1) !== t.count) problems.push(`${t.table}: eksport ichidagi son nomuvofiq`);
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        for (const t of [...exp.tables].reverse()) {
          if (!t.rows.length) continue;
          const n = await tx.$executeRawUnsafe(`INSERT INTO "${t.table}" SELECT * FROM jsonb_populate_recordset(NULL::"${t.table}", $1::jsonb)`, JSON.stringify(t.rows));
          if (n !== t.rows.length) problems.push(`${t.table}: tiklangan ${n}, eksportda ${t.rows.length}`);
        }
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
    for (const t of exp.tables) {
      const r = await db.$queryRawUnsafe<Array<{ rows: unknown[] }>>(`SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) AS rows FROM "${t.table}" x`);
      const restored = (r[0]?.rows ?? []) as unknown[];
      const a = canonRows(t.rows);
      const b = canonRows(restored);
      const identical = a.length === b.length && a.every((x, i) => x === b[i]);
      if (!identical) problems.push(`${t.table}: tiklangan qatorlar eksportga teng emas (${b.length} / ${a.length})`);
      tables.push({ table: t.table, exported: t.rows.length, restored: restored.length, identical });
    }
  } finally {
    if (db) await db.$disconnect();
    if (process.env.KEEP_RESTORE_DB !== '1') await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
  }
  const integrityMissing: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(exp.integrity ?? {})) {
    if (v.missing.length) {
      integrityMissing[k] = v.missing;
      problems.push(`tashqi bog'liqlik yetishmaydi: ${k} (${v.missing.length})`);
    }
  }
  return { ok: problems.length === 0, problems, tables, integrityMissing, database: name };
}

if (process.argv[1] && /verify-export\.ts$/.test(process.argv[1])) {
  process.loadEnvFile?.(join(__dirname, '..', '..', '.env'));
  const file = process.argv[2];
  const base = process.env.TEST_DATABASE_URL;
  if (!file || !base) {
    console.error('Usage: TEST_DATABASE_URL=... tsx scripts/demo-cleanup/verify-export.ts <export.json>');
    process.exit(2);
  }
  restoreAndVerify(JSON.parse(readFileSync(file, 'utf8')) as ExportFile, process.env.TEST_DATABASE_URL ?? base)
    .then((r) => {
      process.stdout.write(JSON.stringify({ ok: r.ok, problems: r.problems, tables: r.tables.filter((t) => t.exported > 0), integrityMissing: r.integrityMissing, tempDatabase: `${r.database} (o'chirildi)` }, null, 2) + '\n');
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
