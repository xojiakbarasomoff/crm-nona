import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import type { TestProject } from 'vitest/node';
import { PrismaClient } from '../../packages/database/generated/client';

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrl: string;
  }
}

/**
 * Real PostgreSQL + Redis (TZ §23). Each run creates a fresh, uniquely named database
 * (crm_it_<timestamp>), applies migrations with the non-destructive `migrate deploy`, seeds it,
 * and drops only that database on teardown. Existing databases are never reset.
 * Requires `npm run dev:infra`.
 */
export default async function setup(project: TestProject) {
  process.loadEnvFile?.(join(__dirname, '..', '..', '.env'));
  const base = process.env.TEST_DATABASE_URL;
  const redisUrl = process.env.TEST_REDIS_URL;
  if (!base || !redisUrl) throw new Error('TEST_DATABASE_URL and TEST_REDIS_URL must be set (see .env.example)');
  const name = `crm_it_${Date.now()}`;
  const url = new URL(base);
  url.pathname = `/${name}`;
  const dbUrl = url.toString();

  const admin = new PrismaClient({ datasources: { db: { url: base } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  const root = join(__dirname, '..', '..');
  const env = { ...process.env, DATABASE_URL: dbUrl, APP_MODE: 'demo' };
  execSync('npx prisma migrate deploy --schema packages/database/prisma/schema.prisma', { cwd: root, env, stdio: 'pipe' });
  execSync('npx tsx --conditions=development packages/database/src/seed.ts', { cwd: root, env, stdio: 'pipe' });
  const redis = new Redis(redisUrl);
  await redis.flushdb();
  redis.disconnect();
  project.provide('dbUrl', dbUrl);

  return async () => {
    if (process.env.KEEP_TEST_DB === '1') return;
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
  };
}
