import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, initializeRoot, assertOwnedRoot, readState, writeState, withTargetLock, materializeRelease, validateRelease, minimalEnvironment } from './delivery-profile.mjs';
import { preflightManager, serviceStatus, startService, stopService } from './delivery-service.mjs';

const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const required = ['package.json', 'package-lock.json', 'frontend/package.json', 'frontend/scripts/bot.ts', 'scripts/delivery.mjs', 'scripts/delivery-profile.mjs', 'scripts/delivery-service.mjs'];
const hash = value => createHash('sha256').update(value).digest('hex');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

export function allowedPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.') || ['test', 'tests', '__tests__', 'fixtures', 'node_modules'].includes(part)) || /\.(?:test|spec)\.ts$/.test(value)) return false;
  return required.includes(value) || /^frontend\/app\/(?:[^/]+\/)*[^/]+\.ts$/.test(value);
}

export function parseArguments(args) {
  const [command, ...rest] = args;
  const specs = { pack: ['sha', 'out'], init: ['config', 'target'], deploy: ['config', 'target', 'artifact', 'sha', 'digest', 'event', 'ref'], rollback: ['config', 'target'], status: ['config', 'target'], stop: ['config', 'target'], __runtime: ['root', 'target', 'release', 'instance'] };
  if (!Object.hasOwn(specs, command)) throw new Error('Invalid command');
  const result = { command };
  if (rest.length !== specs[command].length * 2) throw new Error('Invalid arguments');
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!specs[command].includes(name) || Object.hasOwn(result, name) || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error('Invalid arguments');
    result[name] = rest[i + 1];
  }
  if (result.sha && !shaPattern.test(result.sha)) throw new Error('Invalid revision');
  if (result.digest && !digestPattern.test(result.digest)) throw new Error('Invalid digest');
  for (const key of ['out', 'config', 'artifact', 'root', 'release']) if (result[key] && !path.isAbsolute(result[key])) throw new Error('Absolute path required');
  if (result.target && !['staging', 'production'].includes(result.target)) throw new Error('Invalid target');
  if (result.instance && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.instance)) throw new Error('Invalid instance');
  if (command === 'deploy') authorizeRoute(result.target, result.event, result.ref);
  return result;
}

export function authorizeRoute(target, event, ref) {
  if (!((target === 'staging' && ['push', 'workflow_dispatch'].includes(event) && ref === 'refs/heads/local') || (target === 'production' && event === 'workflow_dispatch' && ref === 'refs/heads/main'))) throw new Error('Unauthorized deployment route');
}

export function validateArtifact(bytes, revision, digest) {
  if (!Buffer.isBuffer(bytes) || !shaPattern.test(revision) || !digestPattern.test(digest) || hash(bytes) !== digest) throw new Error('Invalid artifact digest');
  let envelope;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    envelope = JSON.parse(text);
  } catch { throw new Error('Invalid artifact'); }
  if (!exactKeys(envelope, ['schema', 'revision', 'files']) || envelope.schema !== 1 || envelope.revision !== revision || !Array.isArray(envelope.files)) throw new Error('Invalid artifact envelope');
  const seen = new Set();
  for (const file of envelope.files) {
    if (!exactKeys(file, ['path', 'sha256', 'contentBase64']) || !allowedPath(file.path) || seen.has(file.path) || !digestPattern.test(file.sha256) || typeof file.contentBase64 !== 'string') throw new Error('Invalid artifact entry');
    const content = Buffer.from(file.contentBase64, 'base64');
    if (content.toString('base64') !== file.contentBase64 || hash(content) !== file.sha256) throw new Error('Invalid artifact content');
    seen.add(file.path);
  }
  if (required.some(name => !seen.has(name))) throw new Error('Missing artifact entry');
  // Follow native bot imports, including literal dynamic imports used by its API
  // dispatcher. An allowed but absent module must not become a broken release.
  const entries = new Map(envelope.files.map(file => [file.path, file]));
  const queue = ['frontend/scripts/bot.ts', 'scripts/delivery.mjs'];
  const visited = new Set();
  while (queue.length) {
    const name = queue.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    const source = Buffer.from(entries.get(name).contentBase64, 'base64').toString('utf8');
    const imports = /\b(?:import\s*(?:type\s+)?(?:[^'";]*?\sfrom\s*)?|export\s+(?:type\s+)?[^'";]*?\sfrom\s*|import\s*\(\s*)(['"])([^'"]+)\1/g;
    for (const match of source.matchAll(imports)) {
      const specifier = match[2];
      if (!specifier.startsWith('.')) continue;
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
      if (!allowedPath(dependency) || !entries.has(dependency)) throw new Error('Missing native import');
      queue.push(dependency);
    }
  }
  return envelope;
}

export async function pack(revision, out, repository = process.cwd()) {
  if (!shaPattern.test(revision) || !path.isAbsolute(out)) throw new Error('Invalid pack arguments');
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const resolved = git(['rev-parse', '--verify', `${revision}^{commit}`]).toString('utf8').trim();
  if (resolved !== revision) throw new Error('Revision is not a commit');
  const listing = git(['ls-tree', '-rz', '--full-tree', revision]);
  const files = [];
  for (const entry of listing.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(entry);
    if (!match) throw new Error('Invalid Git tree');
    const [, mode, type, oid, name] = match;
    if (!allowedPath(name)) continue;
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error('Nonregular Git entry');
    const content = git(['cat-file', 'blob', oid]);
    files.push({ path: name, sha256: hash(content), contentBase64: content.toString('base64') });
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const bytes = Buffer.from(JSON.stringify({ schema: 1, revision, files }));
  const digest = hash(bytes);
  validateArtifact(bytes, revision, digest);
  await writeFile(out, bytes, { flag: 'wx', mode: 0o600 });
  return { revision, digest, artifact: out };
}

async function checkedRelease(ctx, record) {
  const result = await validateRelease(ctx, record);
  const bytes = await readFile(path.join(record.dir, 'release.json'));
  validateArtifact(bytes, record.revision, record.digest);
  return result;
}

async function runInstall(ctx, record) {
  let directory;
  try {
    directory = await mkdtemp(path.join(ctx.root, '.install-'));
    const userConfig = path.join(directory, 'user.npmrc');
    const globalConfig = path.join(directory, 'global.npmrc');
    await writeFile(userConfig, '', { flag: 'wx', mode: 0o600 });
    await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 });
    await new Promise((resolve, reject) => {
      const child = spawn(ctx.npmBin, ['ci', '--omit=dev', '--ignore-scripts'], {
        cwd: path.join(record.dir, 'source'),
        env: { ...minimalEnvironment(), HOME: directory, NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_CACHE: path.join(directory, 'cache') },
        stdio: 'ignore',
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
      let failed = false;
      child.once('error', () => { failed = true; });
      child.once('close', code => {
        clearTimeout(timer);
        if (!failed && code === 0) resolve();
        else reject(new Error('Dependency installation failed'));
      });
    });
  } catch {
    throw new Error('Dependency installation failed');
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

function health(record) {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port: record.port, path: '/health', timeout: 1500 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 16384) request.destroy();
      });
      response.on('error', () => resolve(false));
      response.on('end', () => {
        try {
          const value = JSON.parse(body);
          resolve(response.statusCode === 200 && value.service === 'crypto-bot' && value.ready === true && value.revision === record.revision && value.instanceId === record.instanceId);
        } catch { resolve(false); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitHealthy(ctx, record) {
  const deadline = Date.now() + 30_000;
  do {
    const status = await serviceStatus(ctx, record);
    if (status.registered && status.running && status.pid && await health(record)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error('Service readiness failed');
}

export function portFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(new Error('Port inspection failed'));
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(error => error ? reject(new Error('Port inspection failed')) : resolve(true)));
  });
}

async function requireAvailablePort(ctx, port, current, currentStatus) {
  if (await portFree(port)) return;
  if (!current || current.port !== port || !currentStatus.registered || !currentStatus.running || !currentStatus.pid || !await health(current)) throw new Error('Port is not available to the owned service');
}

// A definition can belong to any recorded release after an interrupted operation.
// Refuse to guess if none of the validated records owns the registration.
async function ownedService(ctx, records) {
  let failure;
  for (const record of records.filter(Boolean)) {
    try {
      const status = await serviceStatus(ctx, record);
      return { record, status };
    } catch (error) { failure = error; }
  }
  try {
    const status = await serviceStatus(ctx, null);
    return { record: null, status };
  } catch (error) { throw failure || error; }
}

async function validateRecords(ctx, state) {
  for (const record of [state.current, state.previous, state.pending]) {
    if (record) await checkedRelease(ctx, record);
  }
}

async function recover(ctx, state, candidate, prior, historical) {
  const owned = await ownedService(ctx, [candidate, prior, historical]);
  if (owned.record) await stopService(ctx, owned.record);
  else if (owned.status.registered || owned.status.running) throw new Error('Service ownership is inconsistent');
  if (!prior) {
    await writeState(ctx, { ...state, current: null, previous: owned.record || candidate, pending: null });
    return;
  }
  const restored = { ...prior, instanceId: randomUUID() };
  await checkedRelease(ctx, restored);
  await requireAvailablePort(ctx, restored.port, null, { registered: false, running: false });
  const recovering = { ...state, pending: restored };
  await writeState(ctx, recovering);
  await startService(ctx, restored);
  await waitHealthy(ctx, restored);
  await writeState(ctx, { ...recovering, current: restored, previous: historical, pending: null });
}

async function deploy(ctx, envelope, bytes, digest) {
  await withTargetLock(ctx, async () => {
    const state = await readState(ctx);
    if (state.pending) throw new Error('An operation is pending');
    await validateRecords(ctx, state);
    const currentStatus = await serviceStatus(ctx, state.current || state.previous);
    if (!state.current && currentStatus.running) throw new Error('Unexpected service is running');
    const candidate = await materializeRelease(ctx, envelope, bytes, digest);
    await runInstall(ctx, candidate);
    await checkedRelease(ctx, candidate);
    await requireAvailablePort(ctx, candidate.port, state.current, currentStatus);
    const pending = { ...state, pending: candidate };
    await writeState(ctx, pending);
    try {
      if (state.current) await stopService(ctx, state.current);
      await startService(ctx, candidate);
      await waitHealthy(ctx, candidate);
      await writeState(ctx, { ...pending, current: candidate, previous: state.current, pending: null });
    } catch {
      try {
        await recover(ctx, pending, candidate, state.current, state.previous);
      } catch {
        throw new Error('Deployment and recovery failed; pending state retained');
      }
      throw new Error('Deployment failed; recovery completed');
    }
  });
}

async function rollback(ctx) {
  await withTargetLock(ctx, async () => {
    const state = await readState(ctx);
    await validateRecords(ctx, state);
    const prior = state.current ? (state.pending ? state.current : state.previous) : null;
    if (!prior && !state.pending) throw new Error('No recorded release to restore');
    const owned = await ownedService(ctx, [state.pending, state.current, state.previous]);
    if (!prior) {
      if (owned.record) await stopService(ctx, owned.record);
      await writeState(ctx, { ...state, previous: owned.record || state.pending, pending: null });
      return;
    }
    await requireAvailablePort(ctx, prior.port, owned.record, owned.status);
    const restored = { ...prior, instanceId: randomUUID() };
    // Keep the interrupted definition identifiable until it has been stopped.
    const pending = { ...state, previous: state.pending || state.previous, pending: restored };
    await writeState(ctx, pending);
    try {
      if (owned.record) await stopService(ctx, owned.record);
      await startService(ctx, restored);
      await waitHealthy(ctx, restored);
      await writeState(ctx, { ...pending, current: restored, previous: state.pending ? state.previous : state.current, pending: null });
    } catch {
      try {
        const active = await ownedService(ctx, [restored, owned.record, state.current, state.previous]);
        if (active.record) await stopService(ctx, active.record);
        const fallback = state.current;
        if (!fallback) throw new Error('No recorded recovery release');
        const recovery = { ...fallback, instanceId: randomUUID() };
        await checkedRelease(ctx, recovery);
        await requireAvailablePort(ctx, recovery.port, null, { registered: false, running: false });
        const recovering = { ...pending, pending: recovery };
        await writeState(ctx, recovering);
        await startService(ctx, recovery);
        await waitHealthy(ctx, recovery);
        await writeState(ctx, { ...recovering, current: recovery, previous: state.previous, pending: null });
      } catch {
        throw new Error('Rollback and recovery failed; pending state retained');
      }
      throw new Error('Rollback failed; recovery completed');
    }
  });
}

async function stop(ctx) {
  await withTargetLock(ctx, async () => {
    const state = await readState(ctx);
    await validateRecords(ctx, state);
    const owned = await ownedService(ctx, [state.pending, state.current, state.previous]);
    await stopService(ctx, owned.record);
  });
}

async function status(ctx) {
  const state = await readState(ctx);
  await validateRecords(ctx, state);
  const owned = await ownedService(ctx, [state.pending, state.current, state.previous]);
  let condition = 'stopped';
  if (state.pending || (owned.status.running && (!state.current || owned.record !== state.current))) condition = 'inconsistent';
  else if (owned.status.running) condition = owned.status.pid && await health(state.current) ? 'healthy' : 'unhealthy';
  const record = state.current;
  console.log(JSON.stringify({ status: condition, revision: record?.revision ?? null, digest: record?.digest ?? null, service: owned.status }));
  if (condition === 'unhealthy' || condition === 'inconsistent') process.exitCode = 1;
}

async function runtime(options) {
  if (await realpath(options.root) !== options.root || !process.getuid || process.getuid() === 0) throw new Error('Invalid runtime root');
  const uid = process.getuid();
  const suffix = hash(options.root).slice(0, 16);
  const service = process.platform === 'darwin' ? 'launchd' : process.platform === 'linux' ? 'systemd-user' : null;
  if (!service) throw new Error('Unsupported platform');
  const label = service === 'launchd' ? `com.crypto-tracker.${options.target}.${suffix}` : `crypto-tracker-${options.target}-${suffix}.service`;
  const ctx = { root: options.root, target: options.target, uid, label, service, definitionFile: path.join(options.root, service === 'launchd' ? 'service.plist' : label) };
  await assertOwnedRoot(ctx);
  const state = await readState(ctx);
  const record = [state.pending, state.current, state.previous].find(item => item && item.dir === options.release && item.instanceId === options.instance);
  if (!record) throw new Error('Runtime release is not recorded');
  const { values } = await checkedRelease(ctx, record);
  const child = spawn(process.execPath, ['--experimental-strip-types', path.join(record.dir, 'source/frontend/scripts/bot.ts')], {
    cwd: path.join(record.dir, 'source/frontend'),
    env: { ...minimalEnvironment(), ...values, BOT_REVISION: record.revision, BOT_INSTANCE_ID: record.instanceId },
    stdio: 'inherit',
  });
  let timer;
  const terminate = signal => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    if (!timer) timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
  };
  const onTerm = () => terminate('SIGTERM');
  const onInt = () => terminate('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  const code = await new Promise(resolve => {
    child.once('error', () => resolve(1));
    child.once('close', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 1)));
  });
  clearTimeout(timer);
  process.off('SIGTERM', onTerm);
  process.off('SIGINT', onInt);
  process.exitCode = code;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === 'pack') {
    console.log(JSON.stringify(await pack(options.sha, options.out)));
    return;
  }
  if (options.command === '__runtime') return runtime(options);
  let bytes, envelope;
  if (options.command === 'deploy') {
    bytes = await readFile(options.artifact);
    envelope = validateArtifact(bytes, options.sha, options.digest);
  }
  const ctx = await loadProfile(options.config, options.target, { readEnvironment: options.command === 'init' || options.command === 'deploy' });
  await preflightManager(ctx);
  if (options.command === 'init') return initializeRoot(ctx);
  await assertOwnedRoot(ctx);
  if (options.command === 'deploy') return deploy(ctx, envelope, bytes, options.digest);
  if (options.command === 'rollback') return rollback(ctx);
  if (options.command === 'stop') return stop(ctx);
  return status(ctx);
}

let directEntry = false;
try {
  const evaluated = process.execArgv.some(arg => /^-(?:e|p)/.test(arg) || /^--(?:eval|print)(?:=|$)/.test(arg));
  directEntry = !evaluated && !!process.argv[1] && process.argv[1] !== '-' && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {}
if (directEntry) main().catch(error => {
  const messages = new Set(['Deployment and recovery failed; pending state retained', 'Deployment failed; recovery completed', 'Rollback and recovery failed; pending state retained', 'Rollback failed; recovery completed']);
  if (process.argv[2] === 'status') console.log(JSON.stringify({ status: 'inconsistent', revision: null, digest: null, service: null }));
  console.error(messages.has(error?.message) ? error.message : 'Delivery operation failed.');
  process.exitCode = 1;
});
