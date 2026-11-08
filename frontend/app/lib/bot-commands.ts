import { escapeHtml, normalizeAddress, normalizeChain } from './auth.ts';
import { TRADING_HELP } from './trading-commands.ts';

export type InlineKeyboard = { text: string; callback_data: string }[][];
export interface CommandContext {
  userId: string;
  chatId: string;
  api: (path: string, init?: RequestInit) => Promise<Response>;
  send: (html: string, keyboard?: InlineKeyboard) => Promise<void>;
  scan: () => Promise<{ scannedWallets: number; scannedCoins: number; alertsSent: number; alertsQueued?: number; warnings?: string[] }>;
  confirm: (command: string) => Promise<string>;
  confirmed?: boolean;
}

type RecordValue = Record<string, unknown>;
const PAGE_SIZE = 5;
const HELP = `<b>Perintah bot</b>
/start /help /menu — bantuan dan navigasi
/summary — ringkasan saldo native (bukan seluruh portofolio)
/watchlist [halaman] /coins [halaman]
/addwallet &lt;chain&gt; &lt;alamat&gt; &lt;label&gt;
/renamewallet &lt;chain&gt; &lt;alamat&gt; &lt;label&gt;
/pinwallet &lt;chain&gt; &lt;alamat&gt; on|off
/delwallet &lt;chain&gt; &lt;alamat&gt;
/addcoin &lt;chain&gt; &lt;kontrak&gt; &lt;label&gt;
/renamecoin &lt;chain&gt; &lt;kontrak&gt; &lt;label&gt;
/pincoin &lt;chain&gt; &lt;kontrak&gt; on|off
/delcoin &lt;chain&gt; &lt;kontrak&gt;
/blacklist [halaman] /whitelist [halaman]
/block &lt;chain&gt; &lt;kontrak&gt; &lt;label&gt; /unblock &lt;chain&gt; &lt;kontrak&gt;
/allow &lt;chain&gt; &lt;kontrak&gt; &lt;label&gt; /unallow &lt;chain&gt; &lt;kontrak&gt;
/settings /set ENABLE_COIN_SCANNER true|false
/portfolio &lt;chain&gt; &lt;wallet&gt; [halaman]
/holders &lt;chain&gt; &lt;kontrak&gt;
/history &lt;chain&gt; &lt;wallet&gt; &lt;kontrak&gt; [halaman]
/trades &lt;chain&gt; &lt;kontrak&gt; /indicators &lt;chain&gt; &lt;kontrak&gt;
/scan /search &lt;chain&gt; &lt;kontrak&gt; /analyze &lt;chain&gt; &lt;kontrak&gt;${escapeHtml(TRADING_HELP)}`;

function safe(value: unknown, max = 160): string {
  const text = value == null ? 'unavailable' : String(value);
  return escapeHtml(text.length > max ? `${text.slice(0, max)}…` : text);
}
function pageNumber(value?: string): number {
  if (value === undefined) return 1;
  if (!/^[1-9]\d{0,5}$/.test(value)) throw new Error('page');
  return Number(value);
}
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('response');
  return value as RecordValue;
}
async function request(context: CommandContext, path: string, method = 'GET', body?: RecordValue): Promise<unknown> {
  const response = await context.api(path, body === undefined ? undefined : {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data: unknown = await response.json();
  if (!response.ok || (data && typeof data === 'object' && 'error' in data && (data as RecordValue).error)) throw new Error('unavailable');
  return data;
}
function query(path: string, params: Record<string, string>): string {
  return `${path}?${new URLSearchParams(params).toString()}`;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('response');
  return value;
}
// Limit each field, not the number of records; every record remains reachable.
function formatItem(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return safe(value);
  const item = value as RecordValue;
  const fields = ['label', 'name', 'symbol', 'chain_network', 'wallet_address', 'contract_address', 'address', 'balance', 'price_usd', 'total_value_usd', 'is_primary', 'share', 'type', 'amount', 'timestamp', 'tx_hash', 'txHash', 'maker', 'tokenAmount', 'volumeUsd', 'priceUsd'];
  const lines: string[] = [];
  let length = 0;
  for (const key of fields) {
    if (item[key] === undefined) continue;
    const line = `${safe(key)}: ${safe(item[key], 80)}`;
    if (length + line.length > 500) {
      lines.push('Detail dipersingkat.');
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return lines.length ? lines.join('\n') : 'Detail unavailable';
}
async function list(context: CommandContext, title: string, items: unknown[], page: number, command: string, remotePage = false, hasNext = false): Promise<void> {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const displayed = remotePage ? items : items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const groups: unknown[][] = [];
  for (let i = 0; i < displayed.length; i += PAGE_SIZE) groups.push(displayed.slice(i, i + PAGE_SIZE));
  if (!groups.length) groups.push([]);
  const keyboard: InlineKeyboard = [];
  const row: InlineKeyboard[number] = [];
  const directions: string[] = [];
  if (page > 1) directions.push(`${command} ${page - 1}`);
  if (remotePage ? hasNext : page < totalPages) directions.push(`${command} ${page + 1}`);
  for (const direction of directions) {
    if (new TextEncoder().encode(`cmd:${direction}`).length <= 64) {
      row.push({ text: direction.endsWith(` ${page - 1}`) ? '‹' : '›', callback_data: `cmd:${direction}` });
    }
  }
  if (row.length) keyboard.push(row);
  const instructions = row.length === directions.length ? '' : `\nHalaman lain: ${directions.map(direction => `<code>${safe(direction, 300)}</code>`).join(' · ')}`;
  for (let i = 0; i < groups.length; i++) {
    const lines = groups[i].map(formatItem);
    await context.send(`<b>${safe(title)}</b> — halaman ${page}${remotePage ? '' : `/${totalPages}`}\n\n${lines.length ? lines.join('\n\n') : 'Tidak ada hasil pada halaman ini.'}${i === groups.length - 1 ? instructions : ''}`, i === groups.length - 1 && keyboard.length ? keyboard : undefined);
  }
}
async function allItems(context: CommandContext, title: string, items: unknown[]): Promise<void> {
  if (!items.length) return context.send(`<b>${safe(title)}</b>\nTidak ada hasil.`);
  for (let i = 0; i < items.length; i += PAGE_SIZE) {
    await context.send(`<b>${safe(title)}</b> (${i + 1}–${Math.min(i + PAGE_SIZE, items.length)}/${items.length})\n\n${items.slice(i, i + PAGE_SIZE).map(formatItem).join('\n\n')}`);
  }
}

/** Search and analyze are intentionally delegated to the main analysis dispatcher. */
export async function handleBotCommand(text: string, context: CommandContext): Promise<boolean> {
  const input = text.trim();
  const parts = input.split(/\s+/);
  const command = parts[0]?.split('@')[0].toLowerCase();
  const args = parts.slice(1);
  const known = ['/start', '/help', '/menu', '/summary', '/watchlist', '/coins', '/blacklist', '/whitelist', '/addwallet', '/renamewallet', '/pinwallet', '/delwallet', '/addcoin', '/renamecoin', '/pincoin', '/delcoin', '/block', '/unblock', '/allow', '/unallow', '/settings', '/set', '/portfolio', '/holders', '/history', '/trades', '/indicators', '/scan'];
  if (!known.includes(command)) return false;
  try {
    if (['/start', '/help', '/menu'].includes(command)) {
      await context.send(HELP, [[{ text: 'Watchlist', callback_data: 'cmd:/watchlist' }, { text: 'Coins', callback_data: 'cmd:/coins' }], [{ text: 'Summary', callback_data: 'cmd:/summary' }, { text: 'Settings', callback_data: 'cmd:/settings' }]]);
    } else if (command === '/summary') {
      const [wallets, coins] = await Promise.all([request(context, '/api/watchlist'), request(context, '/api/track')]);
      const w = array(wallets); const c = array(coins);
      await context.send(`<b>Ringkasan</b>\nWallet: ${w.length}\nCoin: ${c.length}\nSaldo native per wallet bukan nilai total portofolio.`);
      if (w.length) await allItems(context, 'Saldo native per wallet', w.map(value => {
        const wallet = record(value);
        return { label: wallet.label, chain_network: wallet.chain_network, wallet_address: wallet.wallet_address, balance: wallet.balance ?? null };
      }));
    } else if (['/watchlist', '/coins', '/blacklist', '/whitelist'].includes(command)) {
      if (args.length > 1) throw new Error('usage');
      const page = pageNumber(args[0]);
      const path = command === '/coins' ? '/api/track' : `/api${command}`;
      await list(context, command.slice(1), array(await request(context, path)), page, command);
    } else if (command === '/settings') {
      const settings = record(await request(context, '/api/settings'));
      await context.send(`<b>Settings</b>\nENABLE_COIN_SCANNER: ${safe(settings.ENABLE_COIN_SCANNER)}`);
    } else if (command === '/set') {
      if (args.length !== 2 || args[0] !== 'ENABLE_COIN_SCANNER' || !['true', 'false'].includes(args[1])) throw new Error('usage');
      await request(context, '/api/settings', 'POST', { key: args[0], value: args[1] });
      await context.send('Pengaturan diperbarui.');
    } else if (command === '/scan') {
      if (args.length) throw new Error('usage');
      const result = await context.scan();
      await context.send(`Scan selesai. Wallet: ${safe(result.scannedWallets)}, coin: ${safe(result.scannedCoins)}, alert diantrekan: ${safe(result.alertsQueued ?? 0)} (belum berarti terkirim).${result.warnings?.length ? `\n${result.warnings.map(w => safe(w, 240)).join('\n')}` : ''}`);
    } else if (['/portfolio', '/holders', '/history', '/trades', '/indicators'].includes(command)) {
      const history = command === '/history'; const portfolio = command === '/portfolio';
      const min = history ? 3 : 2;
      const max = history || portfolio ? min + 1 : min;
      if (args.length < min || args.length > max) throw new Error('usage');
      const chain = normalizeChain(args[0]);
      const address = normalizeAddress(chain, args[1]);
      const mint = history ? normalizeAddress(chain, args[2]) : address;
      const params = { chain_network: chain, contract_address: mint };
      if (portfolio) {
        const page = pageNumber(args[2]);
        const data = record(await request(context, '/api/tokens', 'POST', { chain_network: chain, wallet_address: address, page }));
        await list(context, 'Portfolio', array(data.tokens), page, `/portfolio ${chain} ${address}`, true, data.hasNextPage === true);
      } else if (history) {
        const page = pageNumber(args[3]);
        const data = record(await request(context, query('/api/history', { ...params, wallet_address: address })));
        const entries = array(data.history).map(value => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
          const item = value as RecordValue;
          return { ...item, type: item.type === 'IN' || item.type === 'OUT' ? item.type : 'UNKNOWN' };
        });
        await list(context, 'History — transfer, bukan bukti swap', entries, page, `/history ${chain} ${address} ${mint}`);
      } else {
        const data = record(await request(context, query(`/api${command}`, params)));
        if (command === '/indicators') {
          await context.send(`<b>Indicators</b>\nRSI: ${safe(data.rsi)}\nMACD: ${safe(typeof data.macd === 'object' && data.macd !== null ? JSON.stringify(data.macd) : data.macd, 500)}\nTimeframe: ${safe(data.timeframe)}`);
        } else {
          if (command === '/holders' && (data.source || data.coverage)) {
            await context.send(`<b>Holder source</b>\n${safe(data.source)}\n${safe(data.coverage, 500)}\nSource time: ${safe(data.source_time)}`);
          }
          await allItems(context, command.slice(1), array(data[command.slice(1)]));
        }
      }
    } else {
      const destructive = ['/delwallet', '/delcoin', '/unblock', '/unallow'].includes(command);
      const pin = ['/pinwallet', '/pincoin'].includes(command);
      const wallet = command.includes('wallet');
      if (args.length < (destructive ? 2 : 3) || (destructive && args.length !== 2) || (pin && args.length !== 3)) throw new Error('usage');
      const chain = normalizeChain(args[0]);
      const address = normalizeAddress(chain, args[1]);
      const label = args.slice(2).join(' ');
      if (!destructive && !pin && (!label || label.length > 100)) throw new Error('usage');
      if (pin && !['on', 'off'].includes(label)) throw new Error('usage');
      if (destructive && !context.confirmed) {
        const token = await context.confirm(input);
        await context.send(`Konfirmasi ${safe(command)} untuk ${safe(chain)} <code>${safe(address)}</code>?`, [[{ text: 'Konfirmasi', callback_data: `confirm:${token}` }]]);
        return true;
      }
      const path = wallet ? '/api/watchlist' : ['/block', '/unblock'].includes(command) ? '/api/blacklist' : ['/allow', '/unallow'].includes(command) ? '/api/whitelist' : '/api/track';
      const method = destructive ? 'DELETE' : command.startsWith('/rename') || pin ? 'PATCH' : 'POST';
      let storedChain = chain;
      let storedAddress = address;
      const addressField = wallet ? 'wallet_address' : 'contract_address';
      if (method !== 'POST') {
        const matches = array(await request(context, path)).filter(value => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
          const item = value as RecordValue;
          if (typeof item.chain_network !== 'string' || typeof item[addressField] !== 'string') return false;
          try {
            return normalizeChain(item.chain_network) === chain && normalizeAddress(chain, item[addressField] as string) === address;
          } catch {
            return false;
          }
        });
        if (matches.length !== 1) throw new Error('not found or ambiguous');
        const match = record(matches[0]);
        storedChain = match.chain_network as string;
        storedAddress = match[addressField] as string;
      }
      const body: RecordValue = { chain_network: storedChain, [addressField]: storedAddress };
      if (pin) body.is_primary = label === 'on';
      else if (!destructive) body.label = label;
      await request(context, path, method, body);
      await context.send(`Berhasil: ${safe(command)} ${safe(chain)} <code>${safe(address)}</code>.`);
    }
  } catch {
    await context.send('Perintah tidak valid atau sumber data tidak tersedia. Periksa format di /help dan coba lagi.');
  }
  return true;
}
