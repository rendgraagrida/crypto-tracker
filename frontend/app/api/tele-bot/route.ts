export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  sendTelegramMessage,
  formatWhaleAlert,
  formatRsiAlert,
  formatVolumeAlert,
  formatSummaryMessage,
  formatNewTokenAlert
} from '@/app/lib/telegram';

function getSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * GET: Telegram Bot Health Check & Connection Diagnostics
 */
export async function GET(request: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return NextResponse.json({
      configured: false,
      error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing in environment variables.'
    }, { status: 200 });
  }

  try {
    const getMeRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const botData = await getMeRes.json();

    // Check current webhook status
    const webhookRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const webhookData = await webhookRes.json();

    // Auto-register webhook if we are on a public HTTPS domain and it's not set correctly
    const url = new URL(request.url);
    const hostUrl = `${url.protocol}//${url.host}/api/tele-bot`;
    let webhookRegistered = webhookData?.result?.url === hostUrl;
    
    if (!webhookRegistered && url.protocol === 'https:') {
       const setRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${hostUrl}`);
       const setData = await setRes.json();
       if (setData.ok) {
         webhookRegistered = true;
       }
    }

    return NextResponse.json({
      configured: true,
      botOnline: botData.ok || false,
      botInfo: botData.result || null,
      targetChatId: chatId,
      webhookRegistered,
      webhookUrl: webhookRegistered ? hostUrl : (webhookData?.result?.url || 'None')
    }, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({
      configured: true,
      botOnline: false,
      error: error.message
    }, { status: 500 });
  }
}

/**
 * POST: Telegram Alert Dispatcher, Webhook & Radar Scanner
 */

/** Compact number formatter for Telegram messages (no Intl dependency issues) */
function formatCompact(val: number): string {
  if (!val || val <= 0) return '-';
  if (val >= 1e9) return `$${(val / 1e9).toFixed(1)}B`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(1)}M`;
  if (val >= 1e3) return `$${(val / 1e3).toFixed(1)}K`;
  return `$${val.toFixed(2)}`;
}

/** Chain ID mapping for DexScreener API */
const CHAIN_SLUG: Record<string, string> = {
  'solana': 'solana',
  'sol': 'solana',
  'ethereum': 'ethereum',
  'eth': 'ethereum',
  'bsc': 'bsc',
  'binance': 'bsc',
  'base': 'base',
  'base chain': 'base',
  'robinhood': 'ethereum', // fallback
};

/** Moralis chain slug mapping for EVM */
function getMoralisChain(network: string): string | null {
  const net = (network || '').toUpperCase();
  if (net === 'ETHEREUM' || net.includes('ETH')) return 'eth';
  if (net === 'BASE' || net === 'BASE CHAIN') return 'base';
  if (net === 'BSC' || net === 'BINANCE') return 'bsc';
  return null;
}

/**
 * Fetches live native coin balance for each wallet.
 * EVM via Moralis, Solana via Alchemy RPC.
 * Returns wallets enriched with a numeric `balanceUsd` (native balance in native coin units).
 */
async function fetchWalletBalancesLive(wallets: any[]): Promise<any[]> {
  const moralisKey = process.env.MORALIS_API_KEY || '';
  const heliusKey = process.env.HELIUS_API_KEY;
  const solRpc = process.env.ALCHEMY_SOL_URL || (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : 'https://api.mainnet-beta.solana.com');

  return Promise.all(wallets.map(async (wallet: any) => {
    let nativeBalance: number | null = null;
    const net = (wallet.chain_network || '').toUpperCase();
    const moralisChain = getMoralisChain(net);

    try {
      if (moralisChain && moralisKey) {
        // EVM native balance via Moralis
        const res = await fetch(
          `https://deep-index.moralis.io/api/v2.2/${wallet.wallet_address}/balance?chain=${moralisChain}`,
          { headers: { 'Accept': 'application/json', 'X-API-Key': moralisKey } }
        );
        if (res.ok) {
          const bData = await res.json();
          if (bData.balance) nativeBalance = Number(bData.balance) / 1e18;
          else nativeBalance = 0;
        }
      } else if (net === 'SOLANA') {
        // Solana balance via JSON-RPC
        const res = await fetch(solRpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'getBalance',
            params: [wallet.wallet_address, { commitment: 'confirmed' }]
          })
        });
        if (res.ok) {
          const rpcData = await res.json();
          const lamports = rpcData?.result?.value;
          if (lamports !== undefined) {
            nativeBalance = lamports / 1e9; // lamports -> SOL
          }
        }
      }
    } catch (_e) {
      // silent fail — balance stays null
    }

    return {
      ...wallet,
      nativeBalance,
      balanceDisplay: nativeBalance !== null
        ? `${nativeBalance.toFixed(4)} ${net === 'SOLANA' ? 'SOL' : net === 'BSC' ? 'BNB' : 'ETH'}`
        : 'Unscanned'
    };
  }));
}


/**
 * Fetches live prices from DexScreener for a list of DB coin records.
 * Groups by chain and does batched API calls.
 */
async function fetchCoinPricesFromDex(dbCoins: any[]): Promise<any[]> {
  if (!dbCoins || dbCoins.length === 0) return [];

  // Group coins by chain slug
  const byChain: Record<string, any[]> = {};
  for (const coin of dbCoins) {
    const slug = CHAIN_SLUG[(coin.chain_network || 'ethereum').toLowerCase()] || 'ethereum';
    if (!byChain[slug]) byChain[slug] = [];
    byChain[slug].push(coin);
  }

  const priceMap: Record<string, any> = {};

  // Fetch from DexScreener per chain (max 30 per call)
  for (const [chainSlug, coins] of Object.entries(byChain)) {
    // Batch into groups of 30
    for (let i = 0; i < coins.length; i += 30) {
      const batch = coins.slice(i, i + 30);
      const addresses = batch.map((c: any) => c.contract_address).join(',');
      try {
        const res = await fetch(`https://api.dexscreener.com/tokens/v1/${chainSlug}/${addresses}`, {
          headers: { 'User-Agent': 'PelacakBot/1.0' }
        });
        if (!res.ok) continue;
        const pairs: any[] = await res.json();
        if (!Array.isArray(pairs)) continue;

        // DexScreener returns all pairs — pick best pair per token (highest liquidity)
        const bestPair: Record<string, any> = {};
        for (const pair of pairs) {
          const tokenAddr = (pair.baseToken?.address || '').toLowerCase();
          const liq = pair.liquidity?.usd || 0;
          if (!bestPair[tokenAddr] || liq > (bestPair[tokenAddr].liquidity?.usd || 0)) {
            bestPair[tokenAddr] = pair;
          }
        }
        for (const [addr, pair] of Object.entries(bestPair)) {
          priceMap[addr] = {
            symbol: pair.baseToken?.symbol || null,
            name: pair.baseToken?.name || null,
            priceUsd: parseFloat(pair.priceUsd || '0') || null,
            change24h: pair.priceChange?.h24 ?? null,
            volumeH24: pair.volume?.h24 ?? null,
            marketCap: pair.marketCap ?? null,
          };
        }
      } catch (e) {
        // continue silently on network error
      }
    }
  }

  // Merge DB coin data with live prices
  return dbCoins.map((coin: any) => {
    const addrKey = (coin.contract_address || '').toLowerCase();
    const live = priceMap[addrKey] || {};
    return {
      ...coin,
      symbol: live.symbol || coin.label?.split(' ')[0] || '?',
      name: live.name || coin.label || 'Unknown',
      priceUsd: live.priceUsd ?? null,
      change24h: live.change24h ?? null,
      volumeH24: live.volumeH24 ?? null,
      marketCap: live.marketCap ?? null,
    };
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const supabase = getSupabase();

    // 1. Webhook Handler (Incoming messages sent directly by Telegram servers)
    if (body.update_id && body.message) {
      const incomingText = (body.message.text || '').trim();
      const fromChatId = body.message.chat?.id?.toString();

      if (!fromChatId) {
        return NextResponse.json({ ok: true });
      }

      if (incomingText.startsWith('/start') || incomingText.startsWith('/help')) {
        const welcome = [
          `🤖 <b>PELACAK CRYPTO RADAR BOT</b> 🤖`,
          ``,
          `Welcome to real-time portfolio & whale tracking notifications!`,
          ``,
          `<b>Available Commands:</b>`,
          `  • <code>/summary</code> — View combined net worth & tracking overview`,
          `  • <code>/watchlist</code> — List all active tracked target wallets`,
          `  • <code>/coins</code> — Real-time price & RSI indicators for tracked coins`,
          `  • <code>/search &lt;address&gt;</code> — Search for a token's price and info`,
          `  • <code>/scan</code> — Force immediate scan for whale moves & RSI signals`,
          `  • <code>/help</code> — Show this commands menu`,
          ``,
          `🔗 <i>Web Dashboard: <a href="https://wallettracker-one.vercel.app">wallettracker-one.vercel.app</a></i>`
        ].join('\n');

        await sendTelegramMessage(welcome, { chatId: fromChatId });
        return NextResponse.json({ ok: true });
      }

      if (incomingText.startsWith('/summary')) {
        let walletCount = 0;
        let coinCount = 0;
        let totalNetWorth = 0;
        let topWallets: any[] = [];
        let topCoins: any[] = [];

        if (supabase) {
          const { data: wallets } = await supabase.from('watchlist').select('*').order('is_primary', { ascending: false });
          const { data: dbCoins } = await supabase.from('tracked_coins').select('*').order('is_primary', { ascending: false });

          walletCount = wallets?.length || 0;
          coinCount = dbCoins?.length || 0;

          // Fetch live native coin balances (not stored in DB)
          const walletsWithBalance = await fetchWalletBalancesLive(wallets || []);

          topWallets = walletsWithBalance.map((w: any) => ({
            label: w.label || 'Target',
            balance: w.balanceDisplay,
            network: w.chain_network,
            isPrimary: w.is_primary
          }));

          // For net worth we only count native balance (no USD conversion yet)
          // Just count how many are scanned
          totalNetWorth = 0; // native balance isn't in USD here — show count instead

          // Fetch live prices from DexScreener for tracked coins
          const enrichedCoins = await fetchCoinPricesFromDex(dbCoins || []);
          topCoins = enrichedCoins.map((c: any) => ({
            symbol: c.symbol || c.label || 'COIN',
            priceUsd: c.priceUsd,
            change24h: c.change24h,
            volumeH24: c.volumeH24,
            isPrimary: c.is_primary
          }));
        }

        const msg = formatSummaryMessage({
          walletCount,
          coinCount,
          totalNetWorth,
          topWallets,
          topCoins
        });

        await sendTelegramMessage(msg, { chatId: fromChatId });
        return NextResponse.json({ ok: true });
      }

      if (incomingText.startsWith('/watchlist')) {
        let text = `🎯 <b>TRACKED TARGET WALLETS</b>\n\n`;
        if (supabase) {
          const { data: wallets } = await supabase.from('watchlist').select('*').order('is_primary', { ascending: false }).order('created_at', { ascending: false });
          if (wallets && wallets.length > 0) {
            // Fetch live native balances
            const walletsWithBalance = await fetchWalletBalancesLive(wallets);
            walletsWithBalance.forEach((w: any, i: number) => {
              const icon = w.is_primary ? '⭐' : `${i + 1}.`;
              text += `${icon} <b>${w.label || 'Target'}</b> (<code>${w.wallet_address.slice(0, 6)}...${w.wallet_address.slice(-4)}</code>)\n`;
              text += `   ⛓ ${w.chain_network} | Balance: <b>${w.balanceDisplay}</b>\n\n`;
            });
          } else {
            text += `<i>No target wallets added yet.</i>\n`;
          }
        }
        await sendTelegramMessage(text, { chatId: fromChatId });
        return NextResponse.json({ ok: true });
      }

      if (incomingText.startsWith('/coins')) {
        let text = `🪙 <b>TRACKED COIN WATCHLIST</b>\n\n`;
        if (supabase) {
          const { data: dbCoins } = await supabase.from('tracked_coins').select('*').order('is_primary', { ascending: false }).order('created_at', { ascending: false });
          if (dbCoins && dbCoins.length > 0) {
            // Fetch live prices from DexScreener
            const enrichedCoins = await fetchCoinPricesFromDex(dbCoins);
            enrichedCoins.forEach((c: any, i: number) => {
              const priceStr = c.priceUsd && c.priceUsd > 0
                ? (c.priceUsd < 0.0001
                  ? `$${c.priceUsd.toFixed(8)}`
                  : c.priceUsd < 0.01
                    ? `$${c.priceUsd.toFixed(6)}`
                    : `$${c.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`)
                : '<i>N/A</i>';
              const changeStr = c.change24h !== null && c.change24h !== undefined
                ? ` | 24h: <b>${c.change24h > 0 ? '▲' : '▼'}${Math.abs(c.change24h).toFixed(2)}%</b>`
                : '';
              const volStr = c.volumeH24 && c.volumeH24 > 0
                ? `\n   📊 Vol 24h: <b>${formatCompact(c.volumeH24)}</b>`
                : '';
              text += `${i + 1}. <b>${c.name} (${(c.symbol || '?').toUpperCase()})</b>\n`;
              text += `   💵 Price: <b>${priceStr}</b>${changeStr}${volStr}\n\n`;
            });
          } else {
            text += `<i>No coins tracked yet.</i>\n`;
          }
        }
        await sendTelegramMessage(text, { chatId: fromChatId });
        return NextResponse.json({ ok: true });
      }

      const trimmedText = incomingText.trim();
      const isRawAddress = /^0x[a-fA-F0-9]{40}$/.test(trimmedText) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmedText);

      let isSearchCommand = false;
      let addressToSearch = '';

      if (trimmedText.startsWith('/search')) {
        const parts = trimmedText.split(' ');
        if (parts.length < 2) {
          await sendTelegramMessage(`ℹ️ <b>Usage:</b> /search &lt;contract_address&gt;`, { chatId: fromChatId });
          return NextResponse.json({ ok: true });
        }
        isSearchCommand = true;
        addressToSearch = parts[1].trim();
      } else if (isRawAddress && !trimmedText.includes(' ')) {
        isSearchCommand = true;
        addressToSearch = trimmedText;
      }

      if (isSearchCommand) {
        const address = addressToSearch;
        try {
          const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
          if (!res.ok) throw new Error('API Error');
          const data = await res.json();
          if (!data.pairs || data.pairs.length === 0) {
            await sendTelegramMessage(`❌ No data found for <code>${address}</code> on DexScreener.`, { chatId: fromChatId });
            return NextResponse.json({ ok: true });
          }

          // Get the most liquid pair
          const pair = data.pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

          const priceUsd = parseFloat(pair.priceUsd || '0');
          const priceStr = priceUsd > 0
            ? (priceUsd < 0.0001
              ? `$${priceUsd.toFixed(8)}`
              : priceUsd < 0.01
                ? `$${priceUsd.toFixed(6)}`
                : `$${priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`)
            : '<i>N/A</i>';
            
          const mcap = pair.marketCap ? formatCompact(pair.marketCap) : 'N/A';
          const liq = pair.liquidity?.usd ? formatCompact(pair.liquidity.usd) : 'N/A';
          const vol24h = pair.volume?.h24 ? formatCompact(pair.volume.h24) : 'N/A';
          const change24h = pair.priceChange?.h24 || 0;
          const changeStr = change24h > 0 ? `▲ ${change24h.toFixed(2)}%` : `▼ ${Math.abs(change24h).toFixed(2)}%`;

          let msg = `🔎 <b>COIN SEARCH RESULT</b>\n\n`;
          msg += `<b>Name:</b> ${pair.baseToken?.name} (${pair.baseToken?.symbol})\n`;
          msg += `<b>Chain:</b> ${(pair.chainId || '').toUpperCase()}\n`;
          msg += `<b>Address:</b> <code>${address}</code>\n\n`;
          msg += `💵 <b>Price:</b> ${priceStr} | <b>${changeStr}</b>\n`;
          msg += `💎 <b>Market Cap:</b> $${mcap}\n`;
          msg += `💧 <b>Liquidity:</b> $${liq}\n`;
          msg += `📊 <b>Volume (24h):</b> $${vol24h}\n\n`;
          msg += `<a href="${pair.url}">📈 View Chart on DexScreener</a>`;

          await sendTelegramMessage(msg, { chatId: fromChatId });
        } catch (err) {
          await sendTelegramMessage(`❌ Failed to search for <code>${address}</code>.`, { chatId: fromChatId });
        }
        return NextResponse.json({ ok: true });
      }

      if (incomingText.startsWith('/scan')) {
        const scanRes = await executeRadarScan(supabase);
        await sendTelegramMessage(
          `🔍 <b>RADAR SCAN COMPLETED</b>\n\nChecked <b>${scanRes.scannedCoins} coins</b> and <b>${scanRes.scannedWallets} wallets</b>.\nAlerts dispatched: <b>${scanRes.alertsSent}</b>.`,
          { chatId: fromChatId }
        );
        return NextResponse.json({ ok: true });
      }

      return NextResponse.json({ ok: true });
    }

    // 2. Action: Test Telegram Connection
    if (body.action === 'test') {
      const testMsg = [
        `🟢 <b>PELACAK RADAR BOT: CONNECTION ACTIVE</b>`,
        ``,
        `Your Telegram alert notifications are successfully connected and online.`,
        `Real-time triggers for whale transactions, RSI extremes, and volume surges are enabled.`,
        ``,
        `⏱ <i>Time: ${new Date().toUTCString()}</i>`
      ].join('\n');

      const sendResult = await sendTelegramMessage(testMsg);
      if (sendResult.success) {
        return NextResponse.json({ success: true, message: 'Test message sent to Telegram successfully!' });
      } else {
        return NextResponse.json({ success: false, error: sendResult.error }, { status: 500 });
      }
    }

    // 3. Action: Run On-Demand Radar Scanner
    if (body.action === 'scan_and_alert') {
      const scanRes = await executeRadarScan(supabase);
      return NextResponse.json({
        success: true,
        scannedWallets: scanRes.scannedWallets,
        scannedCoins: scanRes.scannedCoins,
        alertsSent: scanRes.alertsSent,
        alerts: scanRes.alertSummaries
      });
    }

    // 4. Action: Custom Alert Dispatch
    if (body.action === 'send_alert' && body.type) {
      let msg = '';
      if (body.type === 'whale' && body.params) {
        msg = formatWhaleAlert(body.params);
      } else if (body.type === 'rsi' && body.params) {
        msg = formatRsiAlert(body.params);
      } else if (body.type === 'volume' && body.params) {
        msg = formatVolumeAlert(body.params);
      } else if (body.type === 'custom' && body.text) {
        msg = body.text;
      }

      if (msg) {
        const sendResult = await sendTelegramMessage(msg);
        return NextResponse.json({ success: sendResult.success, error: sendResult.error });
      }
    }

    return NextResponse.json({ error: 'Invalid or missing action parameter.' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function scanWalletRecentTrades(supabase: any, wallets: any[], initialAlerts: number, alertSummaries: string[]) {
  let alertsSent = initialAlerts;
  const MAX_AGE_MINUTES = 60; // Flag as new token if pair is younger than this
  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) return alertsSent;

  // We only scan Solana wallets for this feature for now to prevent timeouts
  const solanaWallets = wallets.filter(w => w.chain_network?.toLowerCase() === 'solana' || !w.wallet_address.startsWith('0x'));

  for (const wallet of solanaWallets) {
    try {
      const url = `https://api.helius.xyz/v0/addresses/${wallet.wallet_address}/transactions?api-key=${HELIUS_KEY}&limit=10`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const txList: any[] = await res.json();

      // Find token purchases
      for (const tx of txList) {
        const transfers = tx.tokenTransfers || [];
        for (const t of transfers) {
          // If wallet received a token (BUY)
          if (t.toUserAccount?.toLowerCase() === wallet.wallet_address.toLowerCase()) {
            const contractAddress = t.mint;
            if (!contractAddress) continue;
            
            // Check if already alerted
            const { data: existingAlert } = await supabase
              .from('alert_logs')
              .select('tx_hash')
              .eq('tx_hash', tx.signature)
              .maybeSingle();
            
            if (existingAlert) continue; // Already processed this tx

            // Check DexScreener for token age
            const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`);
            if (!dexRes.ok) continue;
            const dexData = await dexRes.json();
            if (!dexData.pairs || dexData.pairs.length === 0) continue;

            const pair = dexData.pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
            const pairCreatedAt = pair.pairCreatedAt; // timestamp in ms
            if (!pairCreatedAt) continue;

            const ageMinutes = Math.floor((Date.now() - pairCreatedAt) / (60 * 1000));
            
            if (ageMinutes >= 0 && ageMinutes <= MAX_AGE_MINUTES) {
               // Calculate value USD if possible
               let valueUsd = null;
               const solTransfers = tx.nativeTransfers || [];
               let solSpent = 0;
               for (const nt of solTransfers) {
                 if (nt.fromUserAccount?.toLowerCase() === wallet.wallet_address.toLowerCase()) {
                   solSpent += (nt.amount || 0) / 1e9;
                 }
               }
               if (solSpent > 0 && pair.priceNative && pair.priceUsd) {
                 const priceNative = parseFloat(pair.priceNative);
                 const priceUsd = parseFloat(pair.priceUsd);
                 if (priceNative > 0) {
                   const solPrice = priceUsd / priceNative;
                   valueUsd = solSpent * solPrice;
                 }
               }

               // Fire Alert
               const msg = formatNewTokenAlert({
                 whaleName: wallet.label || 'Unknown Whale',
                 whaleAddress: wallet.wallet_address,
                 tokenSymbol: pair.baseToken?.symbol || '?',
                 tokenName: pair.baseToken?.name || 'Unknown',
                 contractAddress: contractAddress,
                 chain: 'Solana',
                 ageMinutes: ageMinutes,
                 amountToken: t.tokenAmount || 0,
                 valueUsd: valueUsd,
                 txHash: tx.signature
               });

               await sendTelegramMessage(msg);
               alertsSent++;
               alertSummaries.push(`New token snipe alert for ${wallet.label} buying ${pair.baseToken?.symbol}`);

               // Insert to alert_logs (fire and forget)
               await supabase.from('alert_logs').insert([{
                 tx_hash: tx.signature,
                 alert_type: 'new_token_snipe',
                 wallet_address: wallet.wallet_address,
                 contract_address: contractAddress
               }]);
            }
          }
        }
      }
    } catch (e) {
      console.error(`[RADAR SCAN] Error scanning wallet ${wallet.wallet_address}:`, e);
    }
  }
  return alertsSent;
}

/**
 * Core scanning routine that inspects database records and dispatches alerts
 */
async function executeRadarScan(supabase: any) {
  let scannedWallets = 0;
  let scannedCoins = 0;
  let alertsSent = 0;
  const alertSummaries: string[] = [];

  if (!supabase) {
    return { scannedWallets, scannedCoins, alertsSent, alertSummaries };
  }

  // 1. Scan Tracked Coins for RSI Extremes and Volume Surges
  // Controlled via app_settings table (default: false to prioritize wallet scanning)
  let isCoinScannerEnabled = false;
  try {
    const { data: setting } = await supabase.from('app_settings').select('value').eq('key', 'ENABLE_COIN_SCANNER').maybeSingle();
    if (setting) {
      isCoinScannerEnabled = setting.value === 'true';
    } else {
      isCoinScannerEnabled = process.env.ENABLE_COIN_SCANNER === 'true'; // Fallback to env var
    }
  } catch (err) {
    isCoinScannerEnabled = process.env.ENABLE_COIN_SCANNER === 'true';
  }

  if (isCoinScannerEnabled) {
    try {
      const { data: coins } = await supabase.from('tracked_coins').select('*');
      if (coins && coins.length > 0) {
        scannedCoins = coins.length;

      for (const coin of coins) {
        // RSI Extreme check (simulated / stored in DB or recent indicator)
        if (coin.rsi !== undefined && coin.rsi !== null) {
          if (coin.rsi <= 30 || coin.rsi >= 70) {
            const rsiMsg = formatRsiAlert({
              symbol: coin.symbol || 'COIN',
              name: coin.name || coin.label || 'Tracked Asset',
              chain: coin.chain_network || 'Ethereum',
              rsi: Number(coin.rsi),
              priceUsd: coin.price_usd,
              change24h: coin.price_change_h24,
              contractAddress: coin.contract_address
            });
            await sendTelegramMessage(rsiMsg);
            alertsSent++;
            alertSummaries.push(`RSI alert sent for ${coin.symbol} (${coin.rsi})`);
          }
        }

        // Volume Surge check (> $1M)
        if (coin.volume_h24 && coin.volume_h24 >= 1_000_000) {
          const volMsg = formatVolumeAlert({
            symbol: coin.symbol || 'COIN',
            name: coin.name || coin.label || 'Tracked Asset',
            chain: coin.chain_network || 'Ethereum',
            volumeUsd: Number(coin.volume_h24),
            priceUsd: coin.price_usd,
            contractAddress: coin.contract_address
          });
          await sendTelegramMessage(volMsg);
          alertsSent++;
          alertSummaries.push(`Volume surge alert sent for ${coin.symbol} ($${coin.volume_h24})`);
        }
      }
    }
    } catch (err) {
      console.error('[RADAR SCAN] Error scanning coins:', err);
    }
  }

  // 2. Scan Tracked Wallets for New Token Alerts
  try {
    const { data: wallets } = await supabase.from('watchlist').select('*');
    if (wallets && wallets.length > 0) {
      scannedWallets = wallets.length;
      alertsSent = await scanWalletRecentTrades(supabase, wallets, alertsSent, alertSummaries);
    }
  } catch (err) {
    console.error('[RADAR SCAN] Error scanning wallets:', err);
  }

  return { scannedWallets, scannedCoins, alertsSent, alertSummaries };
}