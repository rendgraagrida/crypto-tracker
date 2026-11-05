/**
 * Telegram Bot Helper & Alert Message Formatter for Pelacak Portfolio Tracker
 */

import { formatCurrency, formatTokenPrice, truncateAddress, getExplorerUrl } from './utils.ts';

export interface SendTelegramResult {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Sends a message via Telegram Bot API to the configured or custom chat_id
 */
export async function sendTelegramMessage(
  text: string,
  options?: {
    botToken?: string;
    chatId?: string;
    parseMode?: 'HTML' | 'MarkdownV2';
    disableWebPagePreview?: boolean;
  }
): Promise<SendTelegramResult> {
  const token = options?.botToken || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = options?.chatId || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return {
      success: false,
      error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing from environment variables.'
    };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: options?.parseMode || 'HTML',
        disable_web_page_preview: options?.disableWebPagePreview ?? false
      })
    });

    const data = await response.json();
    if (response.ok && data.ok) {
      return { success: true, data };
    }

    return {
      success: false,
      error: data.description || 'Failed to send message via Telegram API'
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Telegram network request failed'
    };
  }
}

/**
 * Builds HTML alert for Whale / Target Wallet movement
 */
export function formatWhaleAlert(params: {
  targetLabel: string;
  walletAddress: string;
  chain: string;
  action: 'TRANSFER_IN' | 'TRANSFER_OUT' | 'BUY' | 'SELL' | 'BALANCE_CHANGE';
  amountFormatted: string;
  valueUsd?: number;
  txHash?: string;
}): string {
  const icon = params.action === 'TRANSFER_IN' || params.action === 'BUY' ? '🟢' : '🔴';
  const actionText =
    params.action === 'TRANSFER_IN' ? 'Funds Received (In)' :
    params.action === 'TRANSFER_OUT' ? 'Funds Transferred (Out)' :
    params.action === 'BUY' ? 'Token Buy / Swap' :
    params.action === 'SELL' ? 'Token Sell / Swap' : 'Balance Movement';

  const explorerUrl = getExplorerUrl(params.chain, 'NATIVE_COIN', params.walletAddress);

  return [
    `🚨 <b>WHALE RADAR ALERT</b> 🚨`,
    ``,
    `🎯 <b>Target:</b> <code>${params.targetLabel}</code>`,
    `📍 <b>Address:</b> <code>${truncateAddress(params.walletAddress, 6, 4)}</code>`,
    `⛓ <b>Network:</b> <b>${params.chain}</b>`,
    `⚡ <b>Action:</b> ${icon} <b>${actionText}</b>`,
    `💰 <b>Amount:</b> <code>${params.amountFormatted}</code>`,
    params.valueUsd !== undefined && params.valueUsd > 0 ? `💵 <b>Estimated Value:</b> <b>${formatCurrency(params.valueUsd)}</b>` : '',
    ``,
    `🔍 <a href="${explorerUrl}">Inspect Target on Explorer</a>`,
    `⏱ <i>Time: ${new Date().toUTCString()}</i>`
  ].filter(Boolean).join('\n');
}

/**
 * Builds HTML alert for RSI Indicator Extreme (<30 Oversold or >70 Overbought)
 */
export function formatRsiAlert(params: {
  symbol: string;
  name: string;
  chain: string;
  rsi: number;
  priceUsd?: number | null;
  change24h?: number | null;
  contractAddress: string;
}): string {
  const isOversold = params.rsi <= 30;
  const signalIcon = isOversold ? '🟢' : '🔴';
  const signalStatus = isOversold ? 'OVERSOLD (Potential Rebound / Buy Zone)' : 'OVERBOUGHT (Potential Pullback / Take Profit)';
  const dexUrl = `https://dexscreener.com/${params.chain.toLowerCase()}/${params.contractAddress}`;

  return [
    `📊 <b>TECHNICAL INDICATOR SIGNAL</b> 📊`,
    ``,
    `🪙 <b>Coin:</b> <b>${params.name} (${params.symbol.toUpperCase()})</b>`,
    `⛓ <b>Network:</b> ${params.chain}`,
    `⚡ <b>RSI (14-period):</b> ${signalIcon} <b>${params.rsi.toFixed(1)}</b> — <i>${signalStatus}</i>`,
    params.priceUsd ? `💵 <b>Current Price:</b> <b>${formatTokenPrice(params.priceUsd).replace('@ ', '')}</b>` : '',
    params.change24h !== null && params.change24h !== undefined ? `📈 <b>24h Change:</b> <b>${params.change24h > 0 ? '+' : ''}${params.change24h.toFixed(2)}%</b>` : '',
    ``,
    `📈 <a href="${dexUrl}">Open Live Chart on DexScreener</a>`,
    `⏱ <i>Triggered: ${new Date().toUTCString()}</i>`
  ].filter(Boolean).join('\n');
}

/**
 * Builds HTML alert for massive 24h volume explosion
 */
export function formatVolumeAlert(params: {
  symbol: string;
  name: string;
  chain: string;
  volumeUsd: number;
  priceUsd?: number | null;
  contractAddress: string;
}): string {
  const dexUrl = `https://dexscreener.com/${params.chain.toLowerCase()}/${params.contractAddress}`;

  return [
    `🚀 <b>UNUSUAL VOLUME SURGE DETECTED</b> 🚀`,
    ``,
    `🪙 <b>Coin:</b> <b>${params.name} (${params.symbol.toUpperCase()})</b>`,
    `⛓ <b>Network:</b> ${params.chain}`,
    `🌊 <b>24h Volume:</b> <b>${formatCurrency(params.volumeUsd)}</b>`,
    params.priceUsd ? `💵 <b>Price:</b> <b>${formatTokenPrice(params.priceUsd).replace('@ ', '')}</b>` : '',
    ``,
    `📈 <a href="${dexUrl}">View Live Liquidity & Volume on DexScreener</a>`,
    `⏱ <i>Time: ${new Date().toUTCString()}</i>`
  ].filter(Boolean).join('\n');
}

/**
 * Builds HTML alert for new token purchases (Whale Sniper Alert)
 */
export function formatNewTokenAlert(params: {
  whaleName: string;
  whaleAddress: string;
  tokenSymbol: string;
  tokenName: string;
  contractAddress: string;
  chain: string;
  ageMinutes: number;
  amountToken: number;
  valueUsd?: number | null;
  txHash: string;
}): string {
  const dexUrl = `https://dexscreener.com/${params.chain.toLowerCase()}/${params.contractAddress}`;
  const explorerUrl = params.chain.toLowerCase() === 'solana' 
    ? `https://solscan.io/tx/${params.txHash}`
    : `https://etherscan.io/tx/${params.txHash}`; // Simplified for other chains

  return [
    `🚨 <b>WHALE SNIPER ALERT</b> 🚨`,
    ``,
    `🎯 <b>Target:</b> <b>${params.whaleName}</b>`,
    `<code>${params.whaleAddress}</code>`,
    ``,
    `🔥 <b>Just Bought a VERY NEW Token!</b>`,
    `🪙 <b>Token:</b> <b>${params.tokenName} (${params.tokenSymbol.toUpperCase()})</b>`,
    `<code>${params.contractAddress}</code>`,
    `⏱ <b>Token Age:</b> <b>${params.ageMinutes} minutes old</b>`,
    ``,
    `💰 <b>Amount Bought:</b> ${params.amountToken.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${params.tokenSymbol.toUpperCase()}`,
    params.valueUsd ? `💵 <b>Est. USD Value:</b> $${params.valueUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '',
    ``,
    `📈 <a href="${dexUrl}">View Chart on DexScreener</a>`,
    `🔗 <a href="${explorerUrl}">View Transaction</a>`,
    `⏱ <i>Time: ${new Date().toUTCString()}</i>`
  ].filter(Boolean).join('\n');
}

/**
 * Builds HTML formatted portfolio & tracking status summary
 */
export function formatSummaryMessage(params: {
  walletCount: number;
  coinCount: number;
  totalNetWorth: number;
  topWallets?: Array<{ label: string; balance: string; network: string; isPrimary?: boolean }>;
  topCoins?: Array<{ symbol: string; priceUsd?: number | null; rsi?: number | null; change24h?: number | null; isPrimary?: boolean }>;
}): string {
  let text = `💼 <b>PELACAK PORTFOLIO RADAR SUMMARY</b> 💼\n\n`;
  text += `🎯 <b>Tracked Wallets:</b> <b>${params.walletCount} targets</b>\n`;
  text += `🪙 <b>Tracked Coins:</b> <b>${params.coinCount} assets</b>\n\n`;

  if (params.topWallets && params.topWallets.length > 0) {
    text += `<b>Tracked Target Wallets:</b>\n`;
    params.topWallets.slice(0, 5).forEach((w, idx) => {
      const icon = w.isPrimary ? '⭐' : `${idx + 1}.`;
      text += `  ${icon} <code>${w.label}</code> (${w.network}): <b>${w.balance}</b>\n`;
    });
    text += `\n`;
  }

  if (params.topCoins && params.topCoins.length > 0) {
    text += `<b>Active Coin Watchlist:</b>\n`;
    params.topCoins.slice(0, 5).forEach((c) => {
      const priceStr = c.priceUsd && c.priceUsd > 0
        ? (c.priceUsd < 0.0001
          ? `$${c.priceUsd.toFixed(8)}`
          : c.priceUsd < 0.01
            ? `$${c.priceUsd.toFixed(6)}`
            : formatTokenPrice(c.priceUsd).replace('@ ', ''))
        : 'N/A';
      const changeStr = c.change24h !== null && c.change24h !== undefined
        ? ` (${c.change24h > 0 ? '▲' : '▼'}${Math.abs(c.change24h).toFixed(2)}%)`
        : '';
      const rsiStr = c.rsi ? ` | RSI: ${c.rsi.toFixed(1)}` : '';
      const icon = c.isPrimary ? '⭐' : '•';
      text += `  ${icon} <b>${(c.symbol || '?').toUpperCase()}</b>: ${priceStr}${changeStr}${rsiStr}\n`;
    });
    text += `\n`;
  }

  text += `🤖 <i>Bot Status: Active & Monitoring</i>\n`;
  text += `⏱ <i>Generated: ${new Date().toUTCString()}</i>`;

  return text;
}
