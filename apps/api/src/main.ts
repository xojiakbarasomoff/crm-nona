import { createApp } from './app';
import { createCore, loadConfig } from './core';

async function main() {
  const config = loadConfig();
  const core = createCore(config);
  const app = await createApp(core);
  await app.listen(config.apiPort, '0.0.0.0');
  core.deps.logger.info({ port: config.apiPort, mode: config.mode, adapters: core.deps.adapters.descriptors() }, 'API started');
}

main().catch((err) => {
  console.error('API failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
