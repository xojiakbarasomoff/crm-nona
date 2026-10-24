/**
 * Usage:
 *   npm run amo-config -- --company=<uuid> [--pipeline=<id>] [--apply]
 * Without --apply it is a dry run (nothing is created).
 */
import { createCore, loadConfig } from '@crm/api/core';
import { runAmoConfig } from '../../../api/src/core/services/amo-config.service';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

async function main() {
  const core = createCore(loadConfig());
  try {
    const companyId = arg('company') ?? (await core.deps.prisma.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })).id;
    const apply = process.argv.includes('--apply');
    const plan = await runAmoConfig(core.deps, { companyId, pipelineId: arg('pipeline'), apply });
    console.log(`amo-config ${apply ? 'APPLY' : 'DRY-RUN'} — pipeline: ${plan.pipeline ? `${plan.pipeline.name} (${plan.pipeline.id})` : 'not found'}`);
    console.table(plan.statuses);
    console.table(plan.fields);
    if (!apply && [...plan.statuses, ...plan.fields].some((x) => x.status === 'create')) console.log('Run again with --apply to create the missing items.');
  } finally {
    await core.close();
  }
}

main().catch((err) => {
  console.error('amo-config failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
