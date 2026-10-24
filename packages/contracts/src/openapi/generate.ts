import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOpenApi } from './registry';

const out = join(__dirname, '..', '..', '..', '..', 'docs', 'openapi.json');
writeFileSync(out, `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
console.log(`OpenAPI written to ${out}`);
