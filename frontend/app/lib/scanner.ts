import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { RSI } from 'technicalindicators';
import type { BotStore } from './bot-store.ts';
import { assetKey, escapeHtml, normalizeAddress, normalizeChain } from './auth.ts';
import { fetchMarketPairs } from './market-data.ts';
import { readBoundedJson } from './bounded-json.ts';
import { boundedFetch } from './bounded-fetch.ts';
import { getNetworkSlug } from './utils.ts';

const WSOL = 'So11111111111111111111111111111111111111112';
const quotes = new Set([WSOL, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Transfer = { fromUserAccount?: string; toUserAccount?: string; mint?: string; tokenAmount?: number };
export type EnhancedTransaction = { signature?: string; type?: string; tokenTransfers?: Transfer[]; nativeTransfers?: { fromUserAccount?: string; toUserAccount?: string; amount?: number }[]; events?: { swap?: unknown } };
export type Movement = { mint: string; amount: number; action: 'BUY' | 'SELL' | 'UNKNOWN'; eventIndex: number };

/** A transfer by itself is not a swap. Aggregate wallet deltas before classifying. */
export function classifyMovements(tx: EnhancedTransaction, wallet: string): Movement[] {
  const deltas = new Map<string, number>();
  const first = new Map<string, number>();
  for (const [i, t] of (tx.tokenTransfers || []).entries()) {
    if (!t.mint || !Number.isFinite(t.tokenAmount) || t.tokenAmount! <= 0) continue;
    const delta = (t.toUserAccount === wallet ? t.tokenAmount! : 0) - (t.fromUserAccount === wallet ? t.tokenAmount! : 0);
    if (!delta) continue;
    deltas.set(t.mint, (deltas.get(t.mint) || 0) + delta);
    if (!first.has(t.mint)) first.set(t.mint, i);
  }
  const nativeDelta = (tx.nativeTransfers || []).reduce((a, t) => a + (t.toUserAccount === wallet ? t.amount || 0 : 0) - (t.fromUserAccount === wallet ? t.amount || 0 : 0), 0);
  const quoteDelta = [...deltas].filter(([mint]) => quotes.has(mint));
  const swap = tx.type === 'SWAP' && Boolean(tx.events?.swap);
  return [...deltas].filter(([mint, amount]) => !quotes.has(mint) && amount !== 0).map(([mint, amount]) => {
    const oppositeQuote = quoteDelta.some(([, q]) => q * amount < 0) || nativeDelta * amount < 0;
    return { mint, amount: Math.abs(amount), action: swap && oppositeQuote ? (amount > 0 ? 'BUY' : 'SELL') : 'UNKNOWN', eventIndex: first.get(mint)! };
  });
}

export function hourlySignal(candles: number[][]): { rsi: number | null; latestVolume: number | null; baseline: number | null; surge: boolean } {
  const rows = [...candles].filter(c => c.length >= 6 && c.every(Number.isFinite) && (c[0] + 3600) * 1000 <= Date.now()).sort((a, b) => a[0] - b[0]);
  const closes = rows.map(c => c[4]);
  const rsi = closes.length >= 15 ? RSI.calculate({ values: closes, period: 14 }).at(-1) ?? null : null;
  const latestVolume = rows.at(-1)?.[5] ?? null;
  const previous = rows.slice(-21, -1);
  const baseline = previous.length === 20 ? previous.reduce((n, c) => n + c[5], 0) / 20 : null;
  return { rsi, latestVolume, baseline, surge: baseline !== null && baseline > 0 && latestVolume !== null && latestVolume >= baseline * 3 };
}

async function json(url: string): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (!r.ok) throw new Error('Sumber scanner tidak tersedia.');
  return readBoundedJson(r.body, 2_000_000, 8000);
}

let scanning = false;
export async function executeRadarScan(store: BotStore): Promise<{ scannedWallets: number; scannedCoins: number; alertsSent: number; alertsQueued: number; warnings: string[] }> {
  if (scanning) throw new Error('Scanner sedang berjalan.');
  scanning = true;
  try {
    const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!, { auth: { persistSession: false }, global: { fetch: boundedFetch } });
    const [w, c, s] = await Promise.all([db.from('watchlist').select('*'), db.from('tracked_coins').select('*'), db.from('app_settings').select('value').eq('key', 'ENABLE_COIN_SCANNER').maybeSingle()]);
    if (w.error || c.error || s.error) throw new Error('Watchlist/settings scanner tidak tersedia.');
    const warnings: string[] = [];
    let queued = 0;
    let scannedWallets = 0;
    let scannedCoins = 0;
    let paperQueued = 0;
    const destination = process.env.TELEGRAM_CHAT_ID;
    if (!destination) throw new Error('Chat tujuan alert belum dikonfigurasi.');
    async function enqueue(key: string, html: string) {
      await store.ensureLease();
      await store.enqueue(`alert:${hash(key)}`, 'send', { chatId: destination, html });
      queued++;
    }
    const wallets = w.data || [];
    const helius = process.env.HELIUS_API_KEY;
    const threshold = Number(process.env.MIN_WHALE_USD || 100);
    if (!Number.isFinite(threshold) || threshold < 0) throw new Error('MIN_WHALE_USD harus angka nonnegatif.');
    for (const wallet of wallets) {
      let chain: string;
      let address: string;
      try { chain = normalizeChain(wallet.chain_network); address = normalizeAddress(chain, wallet.wallet_address); }
      catch { warnings.push('Watchlist memuat chain/alamat tidak valid.'); continue; }
      if (chain !== 'solana') { warnings.push(`Whale scanner ${chain} belum memiliki sumber swap; tidak diklaim terpantau.`); continue; }
      if (!helius) { warnings.push('HELIUS_API_KEY tidak tersedia; wallet Solana belum dipindai.'); continue; }
      const stateKey = `cursor:${assetKey(chain, address)}`;
      const checkpoint = await store.getState<{ cursor: string; backfill: { before: string; head: string } | null }>(stateKey);
      const cursor = checkpoint?.cursor;
      const backfill = checkpoint?.backfill;
      const txs: EnhancedTransaction[] = [];
      let before = backfill?.before || '';
      let found = !cursor;
      try {
        await store.ensureLease();
        for (let page = 0; page < 3; page++) {
          const query = new URLSearchParams({ 'api-key': helius, limit: '20' });
          if (before) query.set('before', before);
          const data = await json(`https://api.helius.xyz/v0/addresses/${address}/transactions?${query}`);
          if (!Array.isArray(data)) throw new Error('Transaksi tidak valid.');
          for (const tx of data as EnhancedTransaction[]) {
            if (tx.signature === cursor) { found = true; break; }
            if (tx.signature) txs.push(tx);
          }
          if (data.length < 20) found = true;
          if (found) break;
          before = data.at(-1).signature;
        }
        scannedWallets++;
        // First observation establishes a baseline, not a stream of stale buys.
        if (!cursor) {
          if (txs[0]?.signature) await store.setState(stateKey, { cursor: txs[0].signature, backfill: null });
          continue;
        }
        if (!found) warnings.push('Backfill histori berlanjut pada scan berikutnya; cursor utama belum dimajukan.');
        const moves = txs.flatMap(tx => classifyMovements(tx, address).map(move => ({ ...move, signature: tx.signature! })));
        const markets = await fetchMarketPairs('solana', [...new Set(moves.map(m => m.mint))]);
        for (const move of moves.reverse()) {
          const pair = markets.get(move.mint);
          const price = pair?.priceUsd ? Number(pair.priceUsd) : null;
          const value = price && price > 0 ? price * move.amount : null;
          if (value === null) {
            const key = JSON.stringify(['solana', move.signature, move.eventIndex, address, move.action]);
            await store.enqueue(`enrich:${hash(key)}`, 'enrich', { move, address, label: String(wallet.label || address), threshold, destination });
            continue;
          }
          if (value < threshold) continue;
          const html = `<b>WHALE ${move.action}</b>\n${escapeHtml(String(wallet.label || address).slice(0, 160))}\n<code>${escapeHtml(move.mint)}</code>\nJumlah: ${move.amount.toLocaleString('en-US')}\nEstimasi nilai memakai harga saat scan: $${value.toFixed(2)}\n${move.action === 'UNKNOWN' ? 'Transfer; bukti swap belum cukup.\n' : ''}<a href="https://solscan.io/tx/${encodeURIComponent(move.signature)}">Transaksi</a>`;
          await enqueue(JSON.stringify(['solana', move.signature, move.eventIndex, address, move.action]), html);
          if (move.action === 'BUY' && process.env.PAPER_ENABLED === 'true') {
            if (paperQueued < 2) {
              const signal = JSON.stringify(['solana', move.signature, move.eventIndex, address, move.action]);
              await store.enqueue(`paper:${hash(signal)}`, 'paper', { mint: move.mint, source: signal });
              paperQueued++;
            } else warnings.push('Paper capture dibatasi 2 sinyal per scan; coverage tidak lengkap.');
          }
        }
        if (found) {
          await store.setState(stateKey, { cursor: backfill?.head || txs[0]?.signature || cursor, backfill: null });
        } else if (before) {
          await store.setState(stateKey, { cursor, backfill: { before, head: backfill?.head || txs[0]?.signature } });
        }
      } catch { warnings.push('Sumber transaksi wallet gagal; cursor tidak dimajukan.'); }
    }
    const coinEnabled = s.data?.value === 'true' || (!s.data && process.env.ENABLE_COIN_SCANNER === 'true');
    if (coinEnabled) {
      for (const coin of c.data || []) {
        try {
          await store.ensureLease();
          const chain = normalizeChain(coin.chain_network);
          const mint = normalizeAddress(chain, coin.contract_address);
          const pairs = await fetchMarketPairs(chain, [mint]);
          const pair = pairs.get(mint);
          if (!pair?.pairAddress) { warnings.push('Pool indikator tidak tersedia.'); continue; }
          const slug = getNetworkSlug(chain);
          const payload = await json(`https://api.geckoterminal.com/api/v2/networks/${slug}/pools/${encodeURIComponent(pair.pairAddress)}/ohlcv/hour?limit=100`) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
          const signal = hourlySignal(payload.data?.attributes?.ohlcv_list || []);
          scannedCoins++;
          const key = `indicator:${assetKey(chain, mint)}`;
          const old = await store.getState<{ band: string; surge: boolean }>(key);
          const band = signal.rsi === null ? 'unknown' : signal.rsi <= 30 ? 'oversold' : signal.rsi >= 70 ? 'overbought' : 'normal';
          const candle = Math.floor(Date.now() / 3600000);
          if ((band === 'oversold' || band === 'overbought') && old?.band !== band) {
            await enqueue(`${key}:rsi:${band}:${candle}`, `<b>RSI 14 / 1h: ${band}</b>\n${escapeHtml(coin.label || mint)}\nRSI: ${signal.rsi!.toFixed(2)}\nBukan rekomendasi beli/jual.`);
          }
          if (signal.surge && !old?.surge) {
            await enqueue(`${key}:volume:${candle}`, `<b>Lonjakan volume 1h</b>\n${escapeHtml(coin.label || mint)}\nVolume candle selesai: $${signal.latestVolume!.toFixed(2)}\nBaseline 20 candle 1h: $${signal.baseline!.toFixed(2)}\nAmbang: 3x baseline.`);
          }
          await store.setState(key, { band, surge: signal.surge });
        } catch { warnings.push('Indikator tidak tersedia; tidak mengirim sinyal palsu.'); }
      }
    }
    return { scannedWallets, scannedCoins, alertsSent: 0, alertsQueued: queued, warnings: [...new Set(warnings)] };
  } finally { scanning = false; }
}
