import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, realpathSync } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = () => { throw new Error('Invalid delivery profile or private state'); };
const exact = (object, keys) => object !== null && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).sort().join('\0') === [...keys].sort().join('\0');
const text = value => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const portValid = value => Number.isSafeInteger(value) && value >= 1024 && value <= 65535;
const absolute = value => text(value) && path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root;
const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
const ownUid = () => { const uid = process.getuid?.(); if (!Number.isInteger(uid) || uid === 0) fail(); return uid; };

// Reject symlink components, not merely a symlink at the final path.
async function canonical(name) {
  if (!absolute(name)) fail();
  const root = path.parse(name).root;
  let current = root;
  for (const part of name.slice(root.length).split(path.sep)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) fail();
  }
  if (await realpath(name) !== name) fail();
  return await lstat(name);
}
async function privatePath(name, uid, directory = false) {
  const st = await canonical(name);
  if (st.uid !== uid || (st.mode & 0o077) !== 0 || (directory ? !st.isDirectory() : !st.isFile())) fail();
  return st;
}
async function executable(name, uid) {
  const st = await canonical(name);
  if (!st.isFile() || (st.uid !== uid && st.uid !== 0) || (st.mode & 0o022) || !(st.mode & 0o111)) fail();
  await access(name, constants.X_OK);
}
function normalizedUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) fail();
    return url.origin.toLowerCase();
  } catch { fail(); }
}
function environmentValues(values, port) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) fail();
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) fail();
    if (/^(?:NODE_|SSH_|CI(?:_|$)|GITHUB_|RUNNER_|LD_|DYLD_|NPM_CONFIG_|BOT_REVISION$|BOT_INSTANCE_ID$|PATH$|HOME$|USER$|LOGNAME$|TMPDIR$|BASH_ENV$|ENV$|CDPATH$|SHELLOPTS$|NODE$|V8_)/i.test(key) || /(?:PRIVATE.?KEY|SIGNER|SEED.?PHRASE|MNEMONIC)/i.test(key)) fail();
    if (/(?:LIVE|AUTO).*(?:TRAD|EXECUT|SWAP)|(?:TRAD|EXECUT|SWAP).*(?:LIVE|AUTO)/i.test(key) && !/^(?:false|0|off|disabled|)$/i.test(value)) fail();
  }
  if (!values.SUPABASE_URL || !values.SUPABASE_KEY || !values.TELEGRAM_BOT_TOKEN || !values.TELEGRAM_ALLOWED_USER_IDS || !values.TELEGRAM_CHAT_ID || (values.BOT_API_TOKEN || '').length < 32) fail();
  normalizedUrl(values.SUPABASE_URL);
  if (!/^\d+:[^\s:]+$/.test(values.TELEGRAM_BOT_TOKEN)) fail();
  if (!['polling', 'webhook'].includes(values.BOT_TRANSPORT || 'polling')) fail();
  if (values.BOT_TRANSPORT === 'webhook' && !/^[A-Za-z0-9_-]{32,256}$/.test(values.TELEGRAM_WEBHOOK_SECRET || '')) fail();
  if (!/^\d+$/.test(values.BOT_PORT || '') || Number(values.BOT_PORT) !== port) fail();
  if (values.SCAN_INTERVAL_SECONDS && (!Number.isFinite(Number(values.SCAN_INTERVAL_SECONDS)) || Number(values.SCAN_INTERVAL_SECONDS) < 60)) fail();
  return values;
}
function identity(peer, counterpart = false) {
  if (!exact(peer, ['hostId', 'root', 'port', 'supabaseUrl', 'telegramBotId', 'apiTokenSha256', ...(counterpart ? ['target'] : [])]) || !text(peer.hostId) || !absolute(peer.root) || !portValid(peer.port) || !/^\d+$/.test(peer.telegramBotId) || !digestPattern.test(peer.apiTokenSha256)) fail();
  return { url: normalizedUrl(peer.supabaseUrl), bot: peer.telegramBotId, token: peer.apiTokenSha256 };
}
function distinct(identities) {
  for (const key of ['url', 'bot', 'token']) if (new Set(identities.map(item => item[key])).size !== identities.length) fail();
}
async function checkoutRoot() {
  let dir = process.cwd();
  while (true) {
    try { await lstat(path.join(dir, '.git')); return await realpath(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadProfile(configPath, target, { readEnvironment = true } = {}) {
  try {
    const uid = ownUid();
    await privatePath(configPath, uid);
    const profile = JSON.parse(await readFile(configPath, 'utf8'));
    const keys = ['schema', 'target', 'hostId', 'service', 'root', 'port', 'envFile', 'nodeBin', 'npmBin', 'peers'];
    if (Object.hasOwn(profile, 'localWorkspaceRoot')) keys.push('localWorkspaceRoot');
    if (!exact(profile, keys) || profile.schema !== 1 || !['staging', 'production'].includes(target) || profile.target !== target || !text(profile.hostId) || !portValid(profile.port) || !absolute(profile.root) || !absolute(profile.envFile) || !absolute(profile.nodeBin) || !absolute(profile.npmBin) || !exact(profile.peers, ['development', 'counterpart'])) fail();
    if (!((process.platform === 'darwin' && profile.service === 'launchd') || (process.platform === 'linux' && profile.service === 'systemd-user'))) fail();
    const dev = identity(profile.peers.development);
    const other = identity(profile.peers.counterpart, true);
    if (profile.peers.counterpart.target !== (target === 'staging' ? 'production' : 'staging')) fail();
    distinct([dev, other]);
    await privatePath(profile.root, uid, true);
    await executable(profile.nodeBin, uid);
    await executable(profile.npmBin, uid);
    // Recovery uses the recorded snapshot, even if the external file has gone away.
    if (readEnvironment) await privatePath(profile.envFile, uid);
    const checkout = await checkoutRoot();
    if (checkout && (overlaps(profile.root, checkout) || overlaps(profile.envFile, checkout) || overlaps(configPath, checkout))) fail();
    if (overlaps(profile.envFile, path.join(profile.root, 'releases'))) fail();
    if (profile.localWorkspaceRoot !== undefined) {
      if (!absolute(profile.localWorkspaceRoot)) fail();
      const st = await canonical(profile.localWorkspaceRoot);
      if (!st.isDirectory() || st.uid !== uid || overlaps(profile.root, profile.localWorkspaceRoot) || overlaps(profile.envFile, profile.localWorkspaceRoot)) fail();
    }
    for (const peer of [profile.peers.development, profile.peers.counterpart]) {
      if (peer.hostId !== profile.hostId) continue;
      const st = await canonical(peer.root);
      if (!st.isDirectory() || st.uid !== uid || overlaps(peer.root, profile.root) || peer.port === profile.port) fail();
    }
    if (profile.peers.development.hostId === profile.hostId && profile.localWorkspaceRoot !== profile.peers.development.root) fail();
    if (profile.peers.development.hostId === profile.peers.counterpart.hostId && (overlaps(profile.peers.development.root, profile.peers.counterpart.root) || profile.peers.development.port === profile.peers.counterpart.port)) fail();
    const suffix = hash(profile.root).slice(0, 16);
    const label = profile.service === 'launchd' ? `com.crypto-tracker.${target}.${suffix}` : `crypto-tracker-${target}-${suffix}.service`;
    const definitionFile = path.join(profile.root, profile.service === 'launchd' ? 'service.plist' : label);
    const ctx = { ...profile, uid, label, definitionFile };
    if (readEnvironment) {
      const values = environmentValues(parseEnv(await readFile(profile.envFile, 'utf8')), profile.port);
      distinct([dev, other, { url: normalizedUrl(values.SUPABASE_URL), bot: values.TELEGRAM_BOT_TOKEN.split(':')[0], token: hash(values.BOT_API_TOKEN) }]);
      ctx.environment = values;
    }
    return ctx;
  } catch { throw new Error('Invalid delivery profile'); }
}

export async function initializeRoot(ctx) {
  await privatePath(ctx.root, ctx.uid, true);
  if ((await readdir(ctx.root)).length) fail();
  await writeFile(path.join(ctx.root, 'owner.json'), JSON.stringify({ schema: 1, target: ctx.target, root: ctx.root, uid: ctx.uid, serviceLabel: ctx.label }), { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(ctx.root, 'state.json'), JSON.stringify({ schema: 1, current: null, previous: null, pending: null }), { flag: 'wx', mode: 0o600 });
  await mkdir(path.join(ctx.root, 'releases'), { mode: 0o700 });
  await mkdir(path.join(ctx.root, 'logs'), { mode: 0o700 });
}
export async function assertOwnedRoot(ctx) {
  if (ctx.uid !== ownUid()) fail();
  await privatePath(ctx.root, ctx.uid, true);
  const file = path.join(ctx.root, 'owner.json');
  await privatePath(file, ctx.uid);
  let marker;
  try { marker = JSON.parse(await readFile(file, 'utf8')); } catch { fail(); }
  if (!exact(marker, ['schema', 'target', 'root', 'uid', 'serviceLabel']) || marker.schema !== 1 || marker.target !== ctx.target || marker.root !== ctx.root || marker.uid !== ctx.uid || marker.serviceLabel !== ctx.label) fail();
  await privatePath(path.join(ctx.root, 'releases'), ctx.uid, true);
  await privatePath(path.join(ctx.root, 'logs'), ctx.uid, true);
}
function checkRecord(ctx, record) {
  if (!exact(record, ['revision', 'digest', 'dir', 'instanceId', 'environmentSha256', 'port']) || typeof record.revision !== 'string' || !sha.test(record.revision) || typeof record.digest !== 'string' || !digestPattern.test(record.digest) || typeof record.environmentSha256 !== 'string' || !digestPattern.test(record.environmentSha256) || typeof record.instanceId !== 'string' || !uuid.test(record.instanceId) || !portValid(record.port) || typeof record.dir !== 'string') fail();
  const base = `${record.revision}-${record.digest}-`;
  if (path.dirname(record.dir) !== path.join(ctx.root, 'releases') || !path.basename(record.dir).startsWith(base) || !uuid.test(path.basename(record.dir).slice(base.length))) fail();
}
function checkState(ctx, state) {
  if (!exact(state, ['schema', 'current', 'previous', 'pending']) || state.schema !== 1) fail();
  for (const record of [state.current, state.previous, state.pending]) if (record !== null) checkRecord(ctx, record);
}
export async function readState(ctx) {
  await assertOwnedRoot(ctx);
  const file = path.join(ctx.root, 'state.json');
  await privatePath(file, ctx.uid);
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); } catch { fail(); }
  checkState(ctx, state);
  for (const record of [state.current, state.previous, state.pending]) if (record) await privatePath(record.dir, ctx.uid, true);
  return state;
}
export async function writeState(ctx, state) {
  await assertOwnedRoot(ctx);
  checkState(ctx, state);
  for (const record of [state.current, state.previous, state.pending]) if (record) await privatePath(record.dir, ctx.uid, true);
  const file = path.join(ctx.root, 'state.json');
  await privatePath(file, ctx.uid);
  const temp = path.join(ctx.root, `.state-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    await privatePath(file, ctx.uid);
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
export async function withTargetLock(ctx, callback) {
  await assertOwnedRoot(ctx);
  const file = path.join(ctx.root, 'operation.lock');
  // Create once and never unlink: every controller must lock the same inode.
  try {
    const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const st = await privatePath(file, ctx.uid);
  if (st.nlink !== 1 || st.size !== 0) fail();
  // This lock database is never written; any SQLite sidecar is foreign state.
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { await lstat(file + suffix); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    fail();
  }
  const db = new DatabaseSync(file);
  try {
    // An exclusive transaction on an empty database otherwise creates a
    // journal that can survive process death even though the lock is released.
    db.exec('PRAGMA journal_mode = MEMORY');
    db.exec('BEGIN EXCLUSIVE');
    try {
      const locked = await privatePath(file, ctx.uid);
      if (locked.dev !== st.dev || locked.ino !== st.ino || locked.nlink !== 1 || locked.size !== 0) fail();
      return await callback();
    } finally {
      db.exec('ROLLBACK');
    }
  } finally {
    db.close();
  }
}
function safeEntry(file) {
  if (!exact(file, ['path', 'sha256', 'contentBase64']) || typeof file.path !== 'string' || file.path.startsWith('/') || file.path.includes('\\') || /[\x00-\x1f\x7f]/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.') || part === 'node_modules') || !digestPattern.test(file.sha256) || typeof file.contentBase64 !== 'string') fail();
  const bytes = Buffer.from(file.contentBase64, 'base64');
  if (bytes.toString('base64') !== file.contentBase64 || hash(bytes) !== file.sha256) fail();
  return bytes;
}
function envelopeEntries(envelope, revision) {
  if (!exact(envelope, ['schema', 'revision', 'files']) || envelope.schema !== 1 || envelope.revision !== revision || !Array.isArray(envelope.files)) fail();
  const seen = new Set();
  for (const file of envelope.files) { safeEntry(file); if (seen.has(file.path)) fail(); seen.add(file.path); }
}
export async function materializeRelease(ctx, envelope, bytes, digest) {
  await assertOwnedRoot(ctx);
  environmentValues(ctx.environment, ctx.port);
  if (!Buffer.isBuffer(bytes) || !digestPattern.test(digest) || hash(bytes) !== digest || !sha.test(envelope?.revision)) fail();
  envelopeEntries(envelope, envelope.revision);
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(); }
  if (JSON.stringify(parsed) !== JSON.stringify(envelope)) fail();
  const dir = path.join(ctx.root, 'releases', `${envelope.revision}-${digest}-${randomUUID()}`);
  await mkdir(dir, { mode: 0o700 });
  const source = path.join(dir, 'source');
  await mkdir(source, { mode: 0o700 });
  for (const file of envelope.files) {
    const destination = path.join(source, ...file.path.split('/'));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, safeEntry(file), { flag: 'wx', mode: 0o600 });
  }
  await writeFile(path.join(dir, 'release.json'), bytes, { flag: 'wx', mode: 0o600 });
  const snapshot = Buffer.from(JSON.stringify({ schema: 1, values: ctx.environment }));
  await writeFile(path.join(dir, 'environment.json'), snapshot, { flag: 'wx', mode: 0o600 });
  return { revision: envelope.revision, digest, dir, instanceId: randomUUID(), environmentSha256: hash(snapshot), port: ctx.port };
}
export async function validateRelease(ctx, record) {
  await assertOwnedRoot(ctx);
  checkRecord(ctx, record);
  await privatePath(record.dir, ctx.uid, true);
  const source = path.join(record.dir, 'source');
  await privatePath(source, ctx.uid, true);
  const releaseFile = path.join(record.dir, 'release.json');
  const environmentFile = path.join(record.dir, 'environment.json');
  await privatePath(releaseFile, ctx.uid);
  await privatePath(environmentFile, ctx.uid);
  const bytes = await readFile(releaseFile);
  const snapshot = await readFile(environmentFile);
  if (hash(bytes) !== record.digest || hash(snapshot) !== record.environmentSha256) fail();
  let envelope, env;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); env = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot)); } catch { fail(); }
  envelopeEntries(envelope, record.revision);
  if (!exact(env, ['schema', 'values']) || env.schema !== 1) fail();
  environmentValues(env.values, record.port);
  const expected = new Set(envelope.files.map(file => file.path));
  async function inspectDirectory(dir, prefix = '') {
    await privatePath(dir, ctx.uid, true);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.name === 'node_modules' && (prefix === '' || prefix === 'frontend')) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
        continue;
      }
      if (entry.isDirectory() && [...expected].some(name => name.startsWith(`${relative}/`))) await inspectDirectory(full, relative);
      else if (!entry.isFile() || !expected.has(relative)) fail();
    }
  }
  await inspectDirectory(source);
  for (const file of envelope.files) {
    const filePath = path.join(source, ...file.path.split('/'));
    await privatePath(filePath, ctx.uid);
    if (hash(await readFile(filePath)) !== file.sha256) fail();
  }
  return { values: env.values, envelope };
}
export function minimalEnvironment() {
  const result = { PATH: [...new Set([path.dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'])].join(':') };
  if (absolute(process.env.HOME)) result.HOME = process.env.HOME;
  for (const key of ['USER', 'LOGNAME']) if (text(process.env[key]) && /^[A-Za-z0-9_.-]+$/.test(process.env[key])) result[key] = process.env[key];
  const tmp = process.env.TMPDIR;
  if (absolute(tmp)) {
    try {
      const st = lstatSync(tmp);
      if (st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid?.() && !(st.mode & 0o077) && realpathSync(tmp) === tmp) result.TMPDIR = tmp;
    } catch { /* An untrusted temporary directory is not inherited. */ }
  }
  return result;
}
