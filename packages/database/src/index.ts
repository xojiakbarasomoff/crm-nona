import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';

export * from './generated/client';
export { encryptSecret, decryptSecret, loadEncryptionKey } from './crypto';

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

/** Prisma 7: queries run through the `pg` driver adapter (no Rust query engine binary). */
export function createPrisma(url = process.env.DATABASE_URL): PrismaClient {
  if (!url) throw new Error('DATABASE_URL is not set');
  // Pool size: Prisma 6's engine used cpus*2+1; pg's default of 10 was measurably slower under load.
  const max = Number(process.env.DB_POOL_MAX ?? 25);
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max, idleTimeoutMillis: 30_000 }), log: ['warn', 'error'] });
}
