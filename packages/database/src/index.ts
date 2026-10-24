import { PrismaClient } from '../generated/client';

export * from '../generated/client';
export { encryptSecret, decryptSecret, loadEncryptionKey } from './crypto';

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export function createPrisma(url = process.env.DATABASE_URL): PrismaClient {
  if (!url) throw new Error('DATABASE_URL is not set');
  return new PrismaClient({ datasources: { db: { url } }, log: ['warn', 'error'] });
}
