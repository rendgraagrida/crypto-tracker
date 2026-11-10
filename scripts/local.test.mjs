import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, rm, chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crypto local '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'scripts'));
  await mkdir(join(dir, 'frontend', 'scripts'), { recursive: true });
  await copyFile(join(root, 'local'), join(dir, 'local'));
  await chmod(join(dir, 'local'), 0o755);
  await copyFile(join(root, 'scripts/local.mjs'), join(dir, 'scripts/local.mjs'));
  await writeFile(join(dir, 'frontend/scripts/bot.ts'), `
    import { createServer } from 'node:http';
    if (process.env.FAIL_START === 'yes') process.exit(7);
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ service: 'crypto-bot', ready: true,
        revision: process.env.BOT_REVISION ?? null,
        instanceId: process.env.WRONG_ID === 'yes' ? 'foreign' : process.env.BOT_INSTANCE_ID,
        marker: process.env.MARKER }));
    });
    server.listen(Number(process.env.BOT_PORT), '127.0.0.1');
    process.on('SIGTERM', () => server.close());
    process.on('SIGINT', () => server.close());
  `);
  return dir;
}

async function reserve() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen));
  return { server, port: server.address().port };
}
function close(server) { return new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); }
function run(dir, args = [], env = {}) {
  const child = spawn(join(dir, 'local'), args, { cwd: tmpdir(), env: { ...cleanEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  return { child, exit, output: () => output };
}
async function waitFor(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(30);
  }
  throw new Error('Timed out waiting for launcher');
}

test('launcher resolves its root and explicit environment from caller cwd, then reaps its child', async t => {
  const dir = await fixture(t);
  const envPath = join(dir, 'environment file');
  await writeFile(envPath, `MARKER=from-file\nBOT_REVISION=${'a'.repeat(40)}\nBOT_INSTANCE_ID=stale\n`);
  const reserved = await reserve();
  await close(reserved.server);
  const proc = run(dir, ['--env-file', envPath, '--port', String(reserved.port)], { MARKER: 'from-parent' });
  t.after(() => proc.child.kill('SIGKILL'));
  await waitFor(() => proc.output().includes('Stop: Ctrl-C'));
  const body = await (await fetch(`http://127.0.0.1:${reserved.port}/health`)).json();
  assert.equal(body.marker, 'from-parent');
  assert.equal(body.revision, 'a'.repeat(40));
  assert.match(body.instanceId, /^[0-9a-f-]{36}$/);
  assert.notEqual(body.instanceId, 'stale');
  assert.ok(proc.output().includes(dir));
  proc.child.kill('SIGTERM');
  assert.equal((await proc.exit).code, 143);
  const after = await reservePort(reserved.port);
  await close(after);
});

async function reservePort(port) {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolveListen));
  return server;
}

test('busy port is refused without disturbing its listener', async t => {
  const dir = await fixture(t);
  const { server, port } = await reserve();
  t.after(() => close(server));
  const proc = run(dir, ['--port', String(port)]);
  assert.notEqual((await proc.exit).code, 0);
  assert.match(proc.output(), /choose a free port/);
  assert.equal(server.listening, true);
  assert.doesNotMatch(proc.output(), /Stop: Ctrl-C/);
});

test('invalid flags and child startup failure do not report readiness', async t => {
  const dir = await fixture(t);
  for (const args of [['--port'], ['--port', '1000'], ['--port', '3005', '--port', '3006'], ['--other'], ['--env-file', 'missing-env']]) {
    const proc = run(dir, args);
    assert.notEqual((await proc.exit).code, 0);
    assert.doesNotMatch(proc.output(), /Stop: Ctrl-C/);
  }
  const { server, port } = await reserve();
  await close(server);
  const proc = run(dir, ['--port', String(port)], { FAIL_START: 'yes' });
  assert.notEqual((await proc.exit).code, 0);
  assert.doesNotMatch(proc.output(), /Stop: Ctrl-C/);
});

test('a mismatched instance cannot satisfy readiness', async t => {
  const dir = await fixture(t);
  const { server, port } = await reserve();
  await close(server);
  const proc = run(dir, ['--port', String(port)], { WRONG_ID: 'yes' });
  t.after(() => proc.child.kill('SIGKILL'));
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; }
  });
  await delay(300);
  assert.doesNotMatch(proc.output(), /Stop: Ctrl-C/);
  proc.child.kill('SIGINT');
  assert.equal((await proc.exit).code, 130);
  const after = await reservePort(port);
  await close(after);
});
