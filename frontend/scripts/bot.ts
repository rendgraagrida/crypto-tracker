import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { authorizeApi } from '../app/lib/auth.ts';
import { createBotStore } from '../app/lib/bot-store.ts';
import { dispatchApi } from '../app/lib/api-dispatch.ts';
import { acceptUpdate, runOneJob } from '../app/lib/bot-runtime.ts';
import { telegramRequest, TelegramError } from '../app/lib/telegram.ts';
import { POST as webhook, GET as diagnostics } from '../app/api/tele-bot/route.ts';

const revision = process.env.BOT_REVISION ?? null;
const instanceId = process.env.BOT_INSTANCE_ID ?? null;
if (revision !== null && !/^[0-9a-f]{40}$/.test(revision)) throw new Error('BOT_REVISION harus SHA lowercase 40 karakter.');
if (instanceId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)) throw new Error('BOT_INSTANCE_ID harus UUID.');

const transport = process.env.BOT_TRANSPORT || 'polling';
if (!['polling', 'webhook'].includes(transport)) throw new Error('BOT_TRANSPORT harus polling atau webhook.');
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ALLOWED_USER_IDS || !process.env.TELEGRAM_CHAT_ID || (process.env.BOT_API_TOKEN || '').length < 32) throw new Error('Konfigurasi Telegram, owner, chat dan BOT_API_TOKEN minimal32 karakter diperlukan.');
if (transport === 'webhook' && !/^[A-Za-z0-9_-]{32,256}$/.test(process.env.TELEGRAM_WEBHOOK_SECRET || '')) throw new Error('Secret webhook 32–256 karakter diperlukan.');
const store = createBotStore();
if (!await store.ready()) throw new Error('Antrean belum siap. Terapkan migrasi pada database uji yang disetujui terlebih dahulu.');
if (transport === 'polling') {
  const info = await telegramRequest('getWebhookInfo', {});
  if (info.result && typeof info.result === 'object' && 'url' in info.result && info.result.url) throw new Error('Webhook masih terpasang. Bot tidak mengubah transport Telegram otomatis.');
}
const shutdown = new AbortController();
let wake: (() => void) | undefined;
let shuttingDown = false;
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > 65536) { res.writeHead(413); res.end(); return; }
      chunks.push(Buffer.from(chunk));
    }
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400); res.end(); return; }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
    const request = new Request(`http://127.0.0.1${req.url || '/'}`, { method: req.method || 'GET', headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    const path = new URL(request.url).pathname;
    let response: Response;
    if (path === '/health') {
      const ready = !shuttingDown && await store.ready();
      response = Response.json({ service: 'crypto-bot', ready, revision, instanceId }, { status: ready ? 200 : 503 });
    }
    else if (path === '/api/tele-bot' && req.method === 'POST') { response = await webhook(request); wake?.(); }
    else {
      const denied = authorizeApi(request);
      response = denied || (path === '/api/tele-bot' && req.method === 'GET' ? await diagnostics(request) : await dispatchApi(request));
    }
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"Operasi bot gagal; data rahasia tidak ditampilkan."}'); }
});
server.requestTimeout = 20000;
server.headersTimeout = 10000;
const port = Number(process.env.BOT_PORT || 3005);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('BOT_PORT tidak valid.');
server.listen(port, '127.0.0.1', () => console.log(`Crypto bot native siap pada loopback:${port}; transport ${transport}.`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { shuttingDown = true; shutdown.abort(); wake?.(); server.close(); });

async function poll() {
  if (transport !== 'polling') return;
  // Transport prerequisites were checked before opening HTTP or claiming any job.
  let offset = await store.getState<number>('telegram:offset') || 0;
  while (!shuttingDown) {
    try {
      const data = await telegramRequest('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      const updates = data.result;
      if (!Array.isArray(updates)) throw new Error('Update tidak valid.');
      for (const update of updates) {
        if (!await acceptUpdate(store, update)) throw new Error('Update tidak valid.');
        offset = update.update_id + 1;
        await store.setState('telegram:offset', offset);
      }
      if (updates.length) wake?.();
    } catch (error) {
      console.error('Polling tertunda; tidak memajukan offset tanpa penyimpanan.');
      await delay((error instanceof TelegramError && error.retryAfter ? error.retryAfter : 5) * 1000, undefined, { signal: shutdown.signal }).catch(() => {});
    }
  }
}

async function work() {
  let nextScan = 0;
  let nextPaper = 0;
  let maintenanceDate = '';
  const scanInterval = Number(process.env.SCAN_INTERVAL_SECONDS || 300);
  if (!Number.isFinite(scanInterval) || scanInterval < 60) throw new Error('SCAN_INTERVAL_SECONDS minimal60.');
  while (!shuttingDown) {
    try {
      if (Date.now() >= nextScan) {
        const bucket = Math.floor(Date.now() / (scanInterval * 1000));
        await store.enqueue(`scan:${bucket}`, 'scan', {});
        nextScan = Date.now() + scanInterval * 1000;
      }
      if (process.env.PAPER_ENABLED === 'true' && Date.now() >= nextPaper) {
        await store.enqueue(`paper-settle:${Math.floor(Date.now() / 60000)}`, 'paper', { action: 'settle' });
        nextPaper = Date.now() + 60000;
      }
      const today = new Date().toISOString().slice(0, 10);
      if (today !== maintenanceDate) {
        await store.enqueue(`maintenance:${today}`, 'maintenance', {});
        maintenanceDate = today;
      }
      if (await runOneJob(store)) continue;
    } catch { console.error('Antrean bot tidak tersedia; tidak mengakui pekerjaan sebagai selesai.'); }
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(() => { wake = undefined; resolve(); }, 15000);
    wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
    if (shuttingDown) wake();
    await promise;
  }
}
try { await Promise.all([poll(), work()]); } catch { console.error('Transport tidak siap; bot dihentikan tanpa mengubah webhook.'); shuttingDown = true; shutdown.abort(); wake?.(); server.close(); process.exitCode = 1; }
