import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'migrations/20261106_base_schema.sql',
  'migrations/20261107_bot_runtime.sql',
  'migrations/20261107_whitelist_chain.sql',
  'operations/preflight.sql',
  'migrations/20261108_identity_constraints.sql',
  'migrations/20261109_paper_trading.sql',
  'migrations/20261110_trade_execution.sql',
  'migrations/20261111_bot_retention.sql',
  'operations/verify.sql',
];
try {
  if (process.argv.length !== 3 || !process.argv[2]) throw new Error('Usage: node scripts/database-bundle.mjs <new-output.sql>');
  const parts = await Promise.all(files.map(async file => `-- BEGIN ${file}\n${await readFile(resolve(root, 'supabase', file), 'utf8')}\n-- END ${file}\n`));
  await writeFile(resolve(process.argv[2]), '-- Generated from canonical SQL sources. Review for an isolated database; no remote operation was performed.\n' + parts.join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('SQL bundle created exclusively from seven migrations, preflight and verification. No database connection was opened.');
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('Usage:') ? error.message : 'Bundle creation rejected. Check destination does not exist and all canonical SQL files are present.');
  process.exitCode = 1;
}
