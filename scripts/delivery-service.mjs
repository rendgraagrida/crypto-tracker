import { execFile } from 'node:child_process';
import { lstat, readFile, readlink, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const injection = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'RUNNER_TRACKING_ID', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH'];

function fail(message) { throw new Error(message); }
function native(ctx) {
  if (!Number.isInteger(ctx.uid) || ctx.uid === 0 || process.getuid?.() !== ctx.uid) fail('Service requires the current non-root user');
  if ((ctx.service === 'launchd' && process.platform !== 'darwin') || (ctx.service === 'systemd-user' && process.platform !== 'linux') || !['launchd', 'systemd-user'].includes(ctx.service)) fail('Service manager does not match this platform');
}
function managerEnv(ctx) {
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME || '' };
  if (ctx.service === 'systemd-user') {
    env.XDG_RUNTIME_DIR = `/run/user/${ctx.uid}`;
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${ctx.uid}/bus`;
  }
  return env;
}
async function command(ctx, executable, args, allowFailure = false) {
  try {
    const result = await exec(executable, args, { env: managerEnv(ctx), timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    if (allowFailure && Number.isInteger(error.code)) return { ok: false, stdout: typeof error.stdout === 'string' ? error.stdout : '', stderr: typeof error.stderr === 'string' ? error.stderr : '' };
    fail('Service manager command failed');
  }
}
async function statOrNull(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function privateFile(ctx, path) {
  const st = await statOrNull(path);
  if (!st) return null;
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== ctx.uid || (st.mode & 0o077) !== 0 || st.nlink !== 1) fail('Service definition is not private and owned');
  return readFile(path, 'utf8');
}
function argsFor(ctx, record) {
  return [ctx.nodeBin, join(record.dir, 'source/scripts/delivery.mjs'), '__runtime', '--root', ctx.root, '--target', ctx.target, '--release', record.dir, '--instance', record.instanceId];
}
async function ownedRoot(ctx) {
  const root = await statOrNull(ctx.root);
  if (!root?.isDirectory() || root.isSymbolicLink() || root.uid !== ctx.uid || (root.mode & 0o077) !== 0 || ctx.definitionFile !== join(ctx.root, ctx.service === 'launchd' ? 'service.plist' : ctx.label)) fail('Invalid service root');
  const text = await privateFile(ctx, join(ctx.root, 'owner.json'));
  let marker;
  try { marker = JSON.parse(text); } catch { fail('Invalid service root marker'); }
  if (!marker || Object.keys(marker).sort().join(',') !== 'root,schema,serviceLabel,target,uid' || marker.schema !== 1 || marker.target !== ctx.target || marker.root !== ctx.root || marker.uid !== ctx.uid || marker.serviceLabel !== ctx.label) fail('Invalid service root marker');
}
function checked(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) fail('Invalid service definition value');
  return value;
}
function xml(value) { return checked(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function systemd(value, expand = false) {
  const escaped = checked(value).replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${expand ? escaped.replaceAll('$', '$$') : escaped}"`;
}
function definition(ctx, record) {
  const args = argsFor(ctx, record);
  const metadata = Buffer.from(JSON.stringify({ dir: record.dir, instanceId: record.instanceId })).toString('base64');
  const working = join(record.dir, 'source/frontend');
  if (ctx.service === 'launchd') {
    const env = injection.map((name) => `    <key>${name}</key><string></string>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- delivery-record:${metadata} -->\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${xml(ctx.label)}</string>\n  <key>LimitLoadToSessionType</key><string>Background</string>\n  <key>ProgramArguments</key>\n  <array>\n${args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}\n  </array>\n  <key>WorkingDirectory</key><string>${xml(working)}</string>\n  <key>EnvironmentVariables</key>\n  <dict>\n${env}\n  </dict>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>ThrottleInterval</key><integer>5</integer>\n  <key>ExitTimeOut</key><integer>15</integer>\n  <key>Umask</key><integer>63</integer>\n  <key>StandardOutPath</key><string>${xml(join(ctx.root, 'logs/service.out.log'))}</string>\n  <key>StandardErrorPath</key><string>${xml(join(ctx.root, 'logs/service.err.log'))}</string>\n</dict>\n</plist>\n`;
  }
  return `# delivery-record:${metadata}\n[Unit]\nDescription=Crypto tracker ${checked(ctx.target)}\n[Service]\nType=exec\nExecStart=${args.map((arg) => systemd(arg, true)).join(' ')}\nWorkingDirectory=${systemd(working)}\nRestart=on-failure\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=15\nUMask=0077\nUnsetEnvironment=${injection.join(' ')}\n`;
}
function recordFromDefinition(ctx, text) {
  const match = text.match(/(?:<!-- |# )delivery-record:([A-Za-z0-9+/=]+)(?: -->)?\n/);
  if (!match) fail('Unknown service definition');
  let record;
  try { record = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')); } catch { fail('Unknown service definition'); }
  if (!record || Object.keys(record).sort().join(',') !== 'dir,instanceId' || typeof record.dir !== 'string' || typeof record.instanceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.instanceId) || dirname(record.dir) !== join(ctx.root, 'releases') || !/^[0-9a-f]{40}-[0-9a-f]{64}-[0-9a-f-]{36}$/.test(record.dir.slice(dirname(record.dir).length + 1)) || definition(ctx, record) !== text) fail('Unknown service definition');
  return record;
}
async function runtimeLink(ctx) {
  const path = `/run/user/${ctx.uid}/systemd/user/${ctx.label}`;
  const st = await statOrNull(path);
  if (!st) return false;
  if (!st.isSymbolicLink() || st.uid !== ctx.uid || resolve(dirname(path), await readlink(path)) !== ctx.definitionFile) fail('Foreign service registration');
  return true;
}
async function linuxProperties(ctx) {
  const properties = ['Id', 'LoadState', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload', 'ActiveState', 'SubState', 'MainPID', 'ExecStart'];
  const result = await command(ctx, '/usr/bin/systemctl', ['--user', 'show', ctx.label, ...properties.map((p) => `--property=${p}`)], true);
  if (!result.ok) fail('Unable to inspect user service');
  const values = Object.create(null);
  for (const line of result.stdout.trimEnd().split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1);
  }
  for (const key of properties) if (!(key in values)) fail('Incomplete user service status');
  return values;
}
async function inspect(ctx, record, text) {
  if (ctx.service === 'launchd') {
    const domain = `user/${ctx.uid}`;
    const result = await command(ctx, '/bin/launchctl', ['print', `${domain}/${ctx.label}`], true);
    if (!result.ok) {
      if (!/Could not find service/i.test(result.stderr)) fail('Unable to inspect launchd service');
      return { registered: false, running: false, pid: null };
    }
    if (!text || !record) fail('Foreign service registration');
    const output = result.stdout;
    const path = output.match(/^\s*path = (.*)$/m)?.[1];
    const program = output.match(/^\s*program = (.*)$/m)?.[1];
    const block = output.match(/^\s*arguments = \{\n([\s\S]*?)^\s*\}/m)?.[1];
    const argv = block?.split('\n').map((line) => line.trim()).filter(Boolean);
    const expected = argsFor(ctx, record);
    if (path !== ctx.definitionFile || program !== expected[0] || !argv || argv.length !== expected.length || argv.some((arg, index) => arg !== expected[index])) fail('Inconsistent launchd service ownership');
    const state = output.match(/^\s*state = (.*)$/m)?.[1];
    if (!state) fail('Incomplete launchd service status');
    const pidValue = output.match(/^\s*pid = (\d+)$/m)?.[1];
    const pid = pidValue ? Number(pidValue) : null;
    return { registered: true, running: state === 'running', pid };
  }
  const linked = await runtimeLink(ctx);
  const p = await linuxProperties(ctx);
  if (p.LoadState === 'not-found' && !linked) return { registered: false, running: false, pid: null };
  if (!linked || !text || !record || p.Id !== ctx.label || p.LoadState !== 'loaded' || p.DropInPaths || p.NeedDaemonReload !== 'no' || !p.FragmentPath || await realpath(p.FragmentPath).catch(() => null) !== ctx.definitionFile) fail('Inconsistent user service ownership');
  const expected = argsFor(ctx, record);
  if (!p.ExecStart.includes(`path=${expected[0]} ; argv[]=${expected.join(' ')} ;`)) fail('Inconsistent user service command');
  const pid = Number(p.MainPID);
  if (!Number.isSafeInteger(pid) || pid < 0) fail('Invalid user service status');
  return { registered: true, running: p.ActiveState === 'active' || p.ActiveState === 'activating' || p.ActiveState === 'deactivating' || p.ActiveState === 'reloading', pid: pid || null };
}

export async function preflightManager(ctx) {
  native(ctx);
  if (ctx.service === 'launchd') {
    await command(ctx, '/bin/launchctl', ['print', `user/${ctx.uid}`]);
    return;
  }
  const runtime = `/run/user/${ctx.uid}`;
  const directory = await statOrNull(runtime);
  const bus = await statOrNull(`${runtime}/bus`);
  if (!directory?.isDirectory() || directory.isSymbolicLink() || directory.uid !== ctx.uid || !bus?.isSocket() || bus.uid !== ctx.uid) fail('User runtime directory or bus unavailable');
  const linger = await command(ctx, '/usr/bin/loginctl', ['show-user', String(ctx.uid), '--property=Linger', '--value']);
  if (linger.stdout.trim() !== 'yes') fail('User manager requires enabled linger');
  await command(ctx, '/usr/bin/systemctl', ['--user', 'show', '--property=Version']);
}

export async function serviceStatus(ctx, record) {
  await ownedRoot(ctx);
  native(ctx);
  const text = await privateFile(ctx, ctx.definitionFile);
  if (text && record && text !== definition(ctx, record)) fail('Service definition does not match release');
  if (text && !record) fail('Unowned service definition exists');
  return inspect(ctx, record, text);
}

async function replaceDefinition(ctx, text) {
  const temporary = join(ctx.root, `.service-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await rename(temporary, ctx.definitionFile);
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function startService(ctx, record) {
  native(ctx);
  await ownedRoot(ctx);
  const oldText = await privateFile(ctx, ctx.definitionFile);
  const oldRecord = oldText ? recordFromDefinition(ctx, oldText) : null;
  const old = await inspect(ctx, oldRecord, oldText);
  if (old.running) fail('Service must be stopped before replacement');
  if (ctx.service === 'launchd' && old.registered) fail('Launchd service must be removed before replacement');
  await replaceDefinition(ctx, definition(ctx, record));
  if (ctx.service === 'launchd') {
    await command(ctx, '/bin/launchctl', ['bootstrap', `user/${ctx.uid}`, ctx.definitionFile]);
  } else {
    if (!old.registered) await command(ctx, '/usr/bin/systemctl', ['--user', '--runtime', 'link', ctx.definitionFile]);
    await command(ctx, '/usr/bin/systemctl', ['--user', 'daemon-reload']);
    await command(ctx, '/usr/bin/systemctl', ['--user', 'start', ctx.label]);
  }
}

export async function stopService(ctx, record) {
  const status = await serviceStatus(ctx, record);
  if (!status.registered) return;
  if (ctx.service === 'launchd') {
    await command(ctx, '/bin/launchctl', ['bootout', `user/${ctx.uid}/${ctx.label}`]);
  } else {
    await command(ctx, '/usr/bin/systemctl', ['--user', 'stop', ctx.label]);
  }
  const deadline = Date.now() + 15000;
  do {
    const current = await serviceStatus(ctx, record);
    if (!current.running && (ctx.service !== 'launchd' || !current.registered)) return;
    await delay(200);
  } while (Date.now() < deadline);
  fail('Service did not stop within the deadline');
}
