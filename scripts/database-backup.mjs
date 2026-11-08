import { spawn } from 'node:child_process';
import { mkdtemp, chmod, link, rm, realpath, lstat } from 'node:fs/promises';
import { basename, dirname, resolve, relative, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Opt-in only. libpq reads PGSERVICE/PGPASSFILE or PG* environment; credentials never enter argv.
// Public-schema archive includes private chat/financial data. Encrypt before off-host retention.
let temporary;
try {
  if (process.argv.length !== 3 || !isAbsolute(process.argv[2])) throw new Error('Usage: node scripts/database-backup.mjs <absolute-new-archive.dump>');
  if (!process.env.PGSERVICE && !(process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE)) throw new Error('config');
  const output = resolve(process.argv[2]);
  const parent = await realpath(dirname(output));
  const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const inside = relative(root, parent);
  if (!inside || (inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside))) throw new Error('outside repository required');
  try {
    await lstat(join(parent, basename(output)));
    throw new Error('destination exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  temporary = await mkdtemp(join(parent, '.crypto-backup-'));
  await chmod(temporary, 0o700);
  const archive = join(temporary, 'public.dump');
  const executable = process.env.PG_DUMP_BIN || 'pg_dump';
  const child = spawn(executable, ['--no-password', '--schema=public', '--format=custom', '--no-owner', '--file', archive], { stdio: ['ignore', 'ignore', 'pipe'] });
  // Preserve ACLs: --no-privileges would make restored functions publicly executable by default.
  child.stderr.resume();
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
  if (code !== 0) throw new Error('pg_dump failed');
  await chmod(archive, 0o600);
  await link(archive, join(parent, basename(output)));
  console.log('Public-schema backup completed, ACLs preserved. Archive is not encrypted; store securely and verify restore before relying on it.');
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('Usage:') ? error.message : 'Backup rejected or failed. Check isolated libpq configuration, output outside checkout, existing destination, client version and filesystem permissions. No credential is logged.');
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
