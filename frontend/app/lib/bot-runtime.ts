import { updateActor, validUpdate, normalizeChain, normalizeAddress, escapeHtml, isOwner } from './auth.ts';
import type { TelegramUpdate } from './auth.ts';
import type { BotJob, BotStore } from './bot-store.ts';
import { internalApi } from './api-dispatch.ts';
import { handleBotCommand } from './bot-commands.ts';
import { analyzeCoin, formatCoinAnalysis } from './coin-analyzer.ts';
import { getHermesNarrative } from './hermes-ai.ts';
import { sendBotMessage, telegramRequest, TelegramError } from './telegram.ts';
import { executeRadarScan } from './scanner.ts';
import { createHash } from 'node:crypto';
import { fetchMarketPairs } from './market-data.ts';
import { handleTradingCommand, evaluatePaper, recordPaperCandidate } from './trading-commands.ts';

export async function acceptUpdate(store: BotStore, value: unknown): Promise<boolean> {
  if (!validUpdate(value)) return false;
  if (updateActor(value)) await store.enqueue(`update:${value.update_id}`, 'update', value as unknown as Record<string, unknown>);
  return true;
}

export async function processUpdate(update: TelegramUpdate, store: BotStore): Promise<void> {
  const actor = updateActor(update);
  if (!actor) return; // Check again when queued work is run: permission may have changed.
  let text = update.message?.text?.trim() || '';
  let confirmed = false;
  const callback = update.callback_query;
  if (callback) {
    try { await telegramRequest('answerCallbackQuery', { callback_query_id: callback.id }); } catch { /* An expired acknowledgement must not authorize an action. */ }
    if (callback.data?.startsWith('confirm:') || callback.data?.startsWith('action:')) {
      const command = await store.consumeConfirmation(callback.data.split(':')[1], actor.userId, actor.chatId, update.update_id);
      if (!command) { await sendBotMessage(actor.chatId, 'Aksi kedaluwarsa, sudah dipakai, atau bukan milik Anda.'); return; }
      text = command;
      confirmed = callback.data.startsWith('confirm:');
    } else if (callback.data?.startsWith('cmd:/')) {
      text = callback.data.slice(4);
    } else return;
  }
  text = text.replace(/^\/(\w+)@[A-Za-z0-9_]+(?=\s|$)/, '/$1');
  const send = async (html: string, keyboard?: { text: string; callback_data: string }[][]) => { await store.ensureLease(); await sendBotMessage(actor.chatId, html, keyboard); };
  const confirm = (command: string) => store.confirm(command, actor.userId, actor.chatId);
  if (await handleTradingCommand(text, { ...actor, updateId: update.update_id, store, confirmed, send, confirm })) return;
  if (!text.startsWith('/') && (/^0x[\da-fA-F]{40}$/.test(text) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text))) {
    if (text.startsWith('0x')) { await send('Alamat EVM dapat ada di beberapa chain. Gunakan /analyze &lt;chain&gt; &lt;alamat&gt; atau /portfolio &lt;chain&gt; &lt;wallet&gt;.'); return; }
    let address: string;
    try { address = normalizeAddress('solana', text); }
    catch { await send('Alamat Solana tidak valid.'); return; }
    const token = await confirm(`/analyze solana ${address}`);
    const wallet = await confirm(`/portfolio solana ${address}`);
    await send('Alamat ini token atau wallet? Pilih tanpa menebak identitasnya.', [[{ text: 'Analisis token', callback_data: `action:${token}` }, { text: 'Portfolio wallet', callback_data: `action:${wallet}` }]]);
    return;
  }
  if (/^\/(analyze|search)(\s|$)/.test(text)) {
    const parts = text.split(/\s+/);
    let chain: string;
    let address: string;
    try {
      if (parts.length === 2 && !parts[1].startsWith('0x')) { chain = 'solana'; address = normalizeAddress(chain, parts[1]); }
      else if (parts.length === 3) { chain = normalizeChain(parts[1]); address = normalizeAddress(chain, parts[2]); }
      else throw new Error('usage');
    } catch { await send('Gunakan /analyze &lt;chain&gt; &lt;contract_address&gt;. Alamat Solana boleh tanpa chain.'); return; }
    if (!['solana', 'ethereum', 'base', 'bsc', 'polygon', 'arbitrum', 'optimism'].includes(chain)) { await send('Sumber audit analisis belum tersedia untuk chain ini.'); return; }
    await store.ensureLease();
    const messageId = await sendBotMessage(actor.chatId, 'Mengambil data pasar dan on-chain. Analisis AI bersifat opsional.');
    const report = await analyzeCoin(address, chain);
    const scorecard = formatCoinAnalysis(report);
    await store.ensureLease();
    await telegramRequest('editMessageText', { chat_id: actor.chatId, message_id: messageId, text: scorecard, parse_mode: 'HTML', disable_web_page_preview: true });
    const narrative = await getHermesNarrative(report);
    await store.ensureLease();
    const suffix = narrative.text ? `\n\n<b>Catatan Hermes</b>\n${escapeHtml(narrative.text.slice(0, 480))}` : '\n\nAI lokal tidak tersedia/tidak lolos validasi; laporan di atas tetap berbasis data.';
    await telegramRequest('editMessageText', { chat_id: actor.chatId, message_id: messageId, text: scorecard + suffix, parse_mode: 'HTML', disable_web_page_preview: true });
    return;
  }
  const handled = await handleBotCommand(text, {
    ...actor, confirmed,
    api: async (path, init) => { await store.ensureLease(); return internalApi(path, init); },
    send, confirm,
    scan: () => executeRadarScan(store),
  });
  if (!handled) await send('Perintah tidak dikenal. Gunakan /help.');
}

export async function processJob(job: BotJob, store: BotStore): Promise<void> {
  if (job.kind === 'update') await processUpdate(job.payload as unknown as TelegramUpdate, store);
  else if (job.kind === 'scan') await executeRadarScan(store);
  else if (job.kind === 'maintenance') {
    for (let batch = 0; batch < 10; batch++) {
      await store.ensureLease();
      const result = await store.cleanup(5000);
      if (result.deletedJobs + result.compactedJobs < 5000 && result.deletedConfirmations < 5000) break;
    }
  }
  else if (job.kind === 'paper') {
    if (job.payload.action === 'settle') { await evaluatePaper(store); return; }
    const userId = process.env.PAPER_OWNER_USER_ID || '';
    const chatId = process.env.PAPER_CHAT_ID || '';
    if (!isOwner(Number(userId), Number(chatId))) throw new Error('Paper actor/chat must be an explicitly allowed owner.');
    const token = normalizeAddress('solana', String(job.payload.mint));
    await recordPaperCandidate(store, { userId, chatId }, job.id, 'solana', token, process.env.PAPER_NOTIONAL_USD || '');
  }
  else if (job.kind === 'send') { await store.ensureLease(); await sendBotMessage(String(job.payload.chatId), String(job.payload.html)); }
  else if (job.kind === 'enrich') {
    const move = job.payload.move as { mint: string; signature: string; amount: number; eventIndex: number; action: string };
    const mint = normalizeAddress('solana', move.mint);
    const markets = await fetchMarketPairs('solana', [mint]);
    const price = Number(markets.get(mint)?.priceUsd);
    if (!Number.isFinite(price) || price <= 0) throw new Error('Harga movement belum tersedia.');
    const value = price * move.amount;
    if (value >= Number(job.payload.threshold)) {
      await store.ensureLease();
      const key = JSON.stringify(['solana', move.signature, move.eventIndex, job.payload.address, move.action]);
      const id = createHash('sha256').update(key).digest('hex');
      await store.enqueue(`alert:${id}`, 'send', { chatId: job.payload.destination, html: `<b>WHALE ${escapeHtml(move.action)}</b>\n${escapeHtml(String(job.payload.label).slice(0, 160))}\n<code>${mint}</code>\nJumlah: ${move.amount}\nEstimasi memakai harga enrichment, bukan harga historis: $${value.toFixed(2)}\n${move.action === 'UNKNOWN' ? 'Transfer; bukti swap belum cukup.' : ''}` });
      if (move.action === 'BUY' && process.env.PAPER_ENABLED === 'true') await store.enqueue(`paper:${id}`, 'paper', { mint, source: key });
    }
  }
}

export async function runOneJob(store: BotStore): Promise<boolean> {
  const job = await store.claim();
  if (!job) return false;
  let leaseLost = false;
  const heartbeat = setInterval(() => { void store.renew(job).catch(() => { leaseLost = true; }); }, 30000);
  try {
    await store.ensureLease();
    await processJob(job, store);
    if (leaseLost) throw new Error('Lease pekerjaan sudah berakhir.');
    await store.ensureLease();
    await store.finish(job);
  } catch (error) {
    if (!leaseLost) await store.retry(job, error instanceof TelegramError && error.retryAfter ? error.retryAfter : undefined);
    console.error(`Bot job ${job.kind} ditunda/gagal; percobaan ${job.attempts}/4.`);
  } finally { clearInterval(heartbeat); }
  return true;
}
