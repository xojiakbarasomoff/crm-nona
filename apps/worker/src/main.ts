import { createCore, loadConfig } from '@crm/api/core';
import { WorkerRuntime } from './runtime';

async function main() {
  const config = loadConfig();
  const core = createCore(config);
  const runtime = new WorkerRuntime(core, { url: config.redisUrl, maxRetriesPerRequest: null } as never);
  await runtime.start();
  const shutdown = async (signal: string) => {
    core.deps.logger.info({ signal }, 'worker stopping');
    await runtime.stop();
    await core.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Worker failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
