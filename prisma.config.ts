import { defineConfig } from 'prisma/config';

// Prisma 7 does not read .env by itself; explicit environment variables always win.
try {
  if (!process.env.DATABASE_URL) process.loadEnvFile('.env');
} catch {
  /* no .env (CI / containers) */
}

// Prisma 7: connection URL for Migrate lives here, not in schema.prisma.
export default defineConfig({
  schema: 'packages/database/prisma/schema.prisma',
  migrations: { path: 'packages/database/prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
