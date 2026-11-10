import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { allowedPath, authorizeRoute, parseArguments, portFree, validateArtifact } from './delivery.mjs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, lstat, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { pack } from './delivery.mjs';
import { assertOwnedRoot, initializeRoot, loadProfile, readState, withTargetLock, writeState } from './delivery-profile.mjs';

// Synthetic identity: this deliberately does not claim to be a Git commit.
const syntheticRevision = 'a'.repeat(40);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const entry = path => ({ path, sha256: digest(Buffer.from(path)), contentBase64: Buffer.from(path).toString('base64') });
const paths = ['package.json', 'package-lock.json', 'frontend/package.json', 'frontend/scripts/bot.ts', 'scripts/delivery.mjs', 'scripts/delivery-profile.mjs', 'scripts/delivery-service.mjs'];
const encode = files => Buffer.from(JSON.stringify({ schema: 1, revision: syntheticRevision, files }));
const validate = bytes => validateArtifact(bytes, syntheticRevision, digest(bytes));

test('port preflight detects a foreign IPv4 loopback listener', async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    assert.equal(await portFree(port), false);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  assert.equal(await portFree(port), true);
});

test('deployment routes and command arguments reject unauthorized or ambiguous input', () => {
  assert.doesNotThrow(() => authorizeRoute('staging', 'push', 'refs/heads/local'));
  assert.doesNotThrow(() => authorizeRoute('production', 'workflow_dispatch', 'refs/heads/main'));
  assert.throws(() => authorizeRoute('production', 'push', 'refs/heads/main'));
  assert.throws(() => authorizeRoute('staging', 'workflow_dispatch', 'refs/heads/main'));
  assert.throws(() => parseArguments(['status', '--target', 'staging', '--target', 'production']));
  assert.throws(() => parseArguments(['pack', '--sha', 'a'.repeat(40), '--out', 'relative']));
  assert.throws(() => parseArguments(['stop', '--config', '/tmp/profile', '--target', 'production', '--extra', 'x']));
  assert.throws(() => parseArguments(['__runtime', '--root', '/tmp/root', '--target', 'staging', '--release', '/tmp/release', '--instance', 'not-a-uuid']));
  assert.throws(() => parseArguments(['__runtime', '--root', '/tmp/root', '--target', 'staging', '--release', '/tmp/release', '--instance', '123e4567-e89b-42d3-a456-426614174000', '--command', '/bin/sh']));
});

test('CLI rejects invalid arguments through directory and file symlinks', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crypto delivery cli '));
  try {
    const source = fileURLToPath(new URL('./delivery.mjs', import.meta.url));
    const directoryLink = path.join(root, 'linked scripts');
    const fileLink = path.join(root, 'linked delivery.mjs');
    await symlink(path.dirname(source), directoryLink, 'dir');
    await symlink(source, fileLink, 'file');
    for (const entry of [path.join(directoryLink, 'delivery.mjs'), fileLink, path.join('linked scripts', 'delivery.mjs')]) {
      const result = spawnSync(process.execPath, [entry, 'invalid-command'], { cwd: root, encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Delivery operation failed\./);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact rejects tampering, missing files, traversal, duplicate paths and noncanonical encoding', () => {
  const files = paths.map(entry);
  const bytes = encode(files);
  assert.equal(validate(bytes).revision, syntheticRevision);
  assert.throws(() => validateArtifact(bytes, syntheticRevision, '0'.repeat(64)));
  assert.throws(() => validate(encode(files.slice(1))));
  assert.throws(() => validate(encode(files.filter(file => file.path !== 'scripts/delivery-service.mjs'))));
  assert.throws(() => validate(encode([...files, entry('frontend/app/../secret.ts')])));
  assert.throws(() => validate(encode([...files, files[0]])));
  assert.throws(() => validate(encode([{ ...files[0], contentBase64: files[0].contentBase64 + '=' }, ...files.slice(1)])));
  assert.throws(() => validate(encode([{ ...files[0], sha256: '0'.repeat(64) }, ...files.slice(1)])));
  assert.equal(allowedPath('frontend/app/.env.ts'), false);
  assert.equal(allowedPath('frontend/app/lib/auth.ts'), true);
});

test('artifact requires transitive native imports, including dynamic imports', () => {
  const file = (name, source) => ({ path: name, sha256: digest(Buffer.from(source)), contentBase64: Buffer.from(source).toString('base64') });
  const base = paths.filter(name => name !== 'frontend/scripts/bot.ts').map(entry);
  const bot = file('frontend/scripts/bot.ts', "import '../app/lib/dispatch.ts';");
  const dispatch = file('frontend/app/lib/dispatch.ts', "export const load = () => import('../api/route.ts');");
  const route = file('frontend/app/api/route.ts', 'export const GET = () => null;');
  assert.throws(() => validate(encode([...base, bot])));
  assert.throws(() => validate(encode([...base, bot, dispatch])));
  assert.doesNotThrow(() => validate(encode([...base, bot, dispatch, route])));
  const controller = file('scripts/delivery.mjs', "import './delivery-profile.mjs'; import './missing.mjs';");
  assert.throws(() => validate(encode([...base.filter(item => item.path !== 'scripts/delivery.mjs'), bot, dispatch, route, controller])));
});

test('packing uses committed Git blobs rather than dirty workspace bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crypto-delivery-git-'));
  const repository = path.join(root, 'repository');
  try {
    await mkdir(repository);
    const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    for (const name of paths) {
      await mkdir(path.dirname(path.join(repository, name)), { recursive: true });
      await writeFile(path.join(repository, name), `committed ${name}`);
    }
    git('add', '--', '.');
    git('commit', '-qm', 'fixture');
    const revision = git('rev-parse', 'HEAD');
    await writeFile(path.join(repository, 'frontend/scripts/bot.ts'), 'dirty workspace');
    const out = path.join(root, 'artifact.json');
    const receipt = await pack(revision, out, repository);
    const envelope = validateArtifact(await readFile(out), revision, receipt.digest);
    assert.equal(Buffer.from(envelope.files.find(file => file.path === 'frontend/scripts/bot.ts').contentBase64, 'base64').toString(), 'committed frontend/scripts/bot.ts');
    await assert.rejects(pack(revision, out, repository));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('private roots refuse foreign ownership, malformed state and concurrent locks', { skip: !process.getuid || process.getuid() === 0 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'crypto-delivery-root-')));
  const ctx = { root, uid: process.getuid(), target: 'staging', label: 'fixture' };
  try {
    await initializeRoot(ctx);
    await assertOwnedRoot(ctx);
    await assert.rejects(initializeRoot(ctx));
    await assert.rejects(assertOwnedRoot({ ...ctx, target: 'production' }));
    await withTargetLock(ctx, async () => {
      await assert.rejects(withTargetLock(ctx, async () => {}));
    });
    await withTargetLock(ctx, async () => {});
    const state = await readState(ctx);
    await assert.rejects(writeState(ctx, { ...state, pending: { dir: '/tmp/foreign' } }));
    await writeFile(path.join(root, 'state.json'), '{"schema":1,"current":null}', { mode: 0o600 });
    await assert.rejects(readState(ctx));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed profile cannot be used for service operations', { skip: !process.getuid || process.getuid() === 0 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'crypto-delivery-config-')));
  try {
    const config = path.join(root, 'profile.json');
    await writeFile(config, '{"schema":1,"target":"staging"}', { mode: 0o600 });
    await assert.rejects(loadProfile(config, 'staging', { readEnvironment: false }));
    await writeFile(config, '{', { mode: 0o600 });
    await assert.rejects(loadProfile(config, 'staging'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('target lock coordinates across processes and recovers after termination', { skip: !process.getuid || process.getuid() === 0 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'crypto-delivery-lock-')));
  const ctx = { root, uid: process.getuid(), target: 'staging', label: 'fixture' };
  try {
    await initializeRoot(ctx);
    for (const killSignal of ['SIGTERM', 'SIGKILL']) {
      const childScript = `
        import { withTargetLock } from './scripts/delivery-profile.mjs';
        const ctx = ${JSON.stringify(ctx)};
        await withTargetLock(ctx, async () => {
          process.stdout.write('LOCKED\\n');
          setInterval(() => {}, 1000);
          await new Promise(() => {});
        });
      `;
      const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let locked = false;
      await new Promise((resolve, reject) => {
        child.stdout.on('data', d => {
          if (d.toString().includes('LOCKED')) {
            locked = true;
            resolve();
          }
        });
        child.once('error', reject);
        setTimeout(() => reject(new Error('Timeout waiting for child lock')), 10000);
      });
      assert.equal(locked, true);

      let contenderCallbackRan = false;
      await assert.rejects(withTargetLock(ctx, async () => {
        contenderCallbackRan = true;
      }));
      assert.equal(contenderCallbackRan, false);

      child.kill(killSignal);
      await new Promise(resolve => child.once('close', resolve));

      let reacquired = false;
      await withTargetLock(ctx, async () => {
        reacquired = true;
      });
      assert.equal(reacquired, true);
    }

    await assert.rejects(withTargetLock(ctx, async () => {
      throw new Error('callback-failed');
    }), /callback-failed/);

    let subsequentAcquired = false;
    await withTargetLock(ctx, async () => {
      subsequentAcquired = true;
    });
    assert.equal(subsequentAcquired, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('target lock fails closed on legacy directory, malformed/nonempty file, foreign ownership, symlink or hardlink', { skip: !process.getuid || process.getuid() === 0 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'crypto-delivery-lock-invalid-')));
  const ctx = { root, uid: process.getuid(), target: 'staging', label: 'fixture' };
  try {
    await initializeRoot(ctx);
    const lockPath = path.join(root, 'operation.lock');

    await mkdir(lockPath, { mode: 0o700 });
    await assert.rejects(withTargetLock(ctx, async () => {}));
    const stDir = await lstat(lockPath);
    assert.equal(stDir.isDirectory(), true);
    await rm(lockPath, { recursive: true, force: true });

    await writeFile(lockPath, 'not-empty', { mode: 0o600 });
    await assert.rejects(withTargetLock(ctx, async () => {}));
    const content = await readFile(lockPath, 'utf8');
    assert.equal(content, 'not-empty');
    await rm(lockPath);

    for (const suffix of ['-journal', '-wal', '-shm']) {
      await writeFile(lockPath, '', { mode: 0o600 });
      await writeFile(lockPath + suffix, 'sidecar', { mode: 0o600 });
      await assert.rejects(withTargetLock(ctx, async () => {}));
      await rm(lockPath + suffix);
      await rm(lockPath);
    }

    await writeFile(lockPath, '', { mode: 0o600 });
    const linkPath = path.join(root, 'operation.lock.link');
    await link(lockPath, linkPath);
    await assert.rejects(withTargetLock(ctx, async () => {}));
    await rm(linkPath);
    await rm(lockPath);

    const targetFile = path.join(root, 'owner.json');
    await symlink(targetFile, lockPath);
    await assert.rejects(withTargetLock(ctx, async () => {}));
    await rm(lockPath);

    await writeFile(lockPath, '', { mode: 0o644 });
    await assert.rejects(withTargetLock(ctx, async () => {}));
    await rm(lockPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
