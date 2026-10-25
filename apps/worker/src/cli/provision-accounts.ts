/**
 * Создание рабочих учётных записей и закрытие старых демо-аккаунтов. Пароли в репозитории не хранятся:
 * спецификация читается из stdin (JSON), в БД пишется только argon2-хеш.
 *
 *   echo '{"accounts":[{"login":"...","fullName":"...","role":"ADMIN","password":"..."}]}' | npm run accounts:provision -- --phase=create
 *   npm run accounts:provision -- --phase=close-legacy
 *
 * Фаза create — создаёт/обновляет аккаунты и назначает администратора дежурным ответственным.
 * Фаза close-legacy — после проверки входа: блокирует старые @demo.local, отзывает сессии и передаёт
 * активные записи администратору. Перед каждым изменением строки сохраняются в `_backup_cutover_20261026`.
 */
import { createCore, loadConfig, type AccountSpec } from '@crm/api/core';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const phase = arg('phase');
  if (phase !== 'create' && phase !== 'close-legacy') throw new Error('Usage: --phase=create|close-legacy');
  const core = createCore(loadConfig());
  try {
    if (phase === 'create') {
      const spec = JSON.parse(await readStdin()) as { accounts: AccountSpec[] };
      console.log(JSON.stringify({ phase, ...(await core.accounts.provision(spec.accounts)) }, null, 2));
    } else {
      console.log(JSON.stringify({ phase, ...(await core.accounts.closeLegacy()) }, null, 2));
    }
  } finally {
    await core.close();
  }
}

main().catch((err) => {
  console.error('accounts:provision failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
