import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(root, 'frontend');
let child;
let stopping = false;
let signalExit = 0;
let killTimer;

function stop(signal = 'SIGTERM') {
  stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000);
    killTimer.unref();
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    signalExit ||= signal === 'SIGINT' ? 130 : 143;
    stop(signal);
  });
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required.');
  let port = 3005;
  let envFile = resolve(frontend, '.env.local');
  let explicitEnv = false;
  const seen = new Set();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--port', '--env-file'].includes(flag) || seen.has(flag)) throw new Error(`Unknown or duplicate option: ${flag}`);
    seen.add(flag);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--port') {
      if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('Port must be an integer from 1024 to 65535.');
      port = Number(value);
    } else {
      envFile = resolve(process.cwd(), value);
      explicitEnv = true;
    }
  }
  try {
    await access(envFile);
    process.loadEnvFile(envFile);
  } catch (error) {
    if (explicitEnv || error.code !== 'ENOENT') throw new Error('Cannot read the selected environment file.');
  }
  const revision = process.env.BOT_REVISION ?? null;
  if (revision !== null && !/^[0-9a-f]{40}$/.test(revision)) throw new Error('BOT_REVISION must be a lowercase 40-character SHA.');
  const instanceId = randomUUID();
  await new Promise((resolveBind, rejectBind) => {
    const probe = createServer();
    probe.once('error', () => rejectBind(new Error(`Cannot bind 127.0.0.1:${port}; choose a free port with --port.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? rejectBind(error) : resolveBind()));
  });
  if (stopping) return;
  child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', `--env-file-if-exists=${envFile}`, 'scripts/bot.ts'], {
    cwd: frontend,
    env: { ...process.env, BOT_PORT: String(port), BOT_INSTANCE_ID: instanceId },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.resume();
  let exited = false;
  let exitCode = 1;
  const exit = new Promise(resolveExit => {
    child.once('error', () => { exited = true; resolveExit(); });
    child.once('exit', (code, signal) => { exited = true; exitCode = code ?? (signal ? 1 : 0); resolveExit(); });
  });
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + 30000;
  let ready = false;
  while (!stopping && !exited && Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      const body = await response.json();
      if (response.status === 200 && body.service === 'crypto-bot' && body.ready === true && body.instanceId === instanceId && body.revision === revision && !exited && !stopping) {
        ready = true;
        break;
      }
    } catch { /* The owned child may still be starting. */ }
    await delay(100);
  }
  if (ready) {
    console.log(`Project: ${root}\nService: crypto-bot\nHealth: ${url}\nStop: Ctrl-C`);
    child.stdout.pipe(process.stdout);
    await exit;
    if (!stopping) throw new Error(`Bot exited unexpectedly (${exitCode}).`);
  } else if (!stopping) {
    stop();
    const exitedEarly = exited;
    await exit;
    throw new Error(exitedEarly ? 'Bot exited before readiness; inspect its startup errors.' : 'Bot readiness timed out; check the selected configuration and port.');
  } else {
    await exit;
  }
  clearTimeout(killTimer);
}

try {
  await main();
  if (signalExit) process.exitCode = signalExit;
} catch (error) {
  stop();
  console.error(`local: ${error.message}`);
  process.exitCode = signalExit || 1;
}
