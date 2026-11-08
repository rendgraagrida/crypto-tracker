import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { handleBotCommand } from '../app/lib/bot-commands.ts';
import type { CommandContext, InlineKeyboard } from '../app/lib/bot-commands.ts';

const sol = 'So11111111111111111111111111111111111111112';
const evm = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

function harness(handler: (path: string, init?: RequestInit) => unknown = () => ({})) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const messages: { html: string; keyboard?: InlineKeyboard }[] = [];
  const confirmations: string[] = [];
  const context: CommandContext = {
    userId: '1', chatId: '2',
    api: async (path, init) => {
      calls.push({ path, init });
      const value = handler(path, init);
      return value instanceof Response ? value : Response.json(value);
    },
    send: async (html, keyboard) => { messages.push({ html, keyboard }); },
    scan: async () => ({ scannedWallets: 2, scannedCoins: 3, alertsSent: 1 }),
    confirm: async command => { confirmations.push(command); return 'token'; },
  };
  return { context, calls, messages, confirmations };
}

describe('bot commands', () => {
  test('delegates analysis, search and raw addresses', async () => {
    const h = harness();
    for (const input of [`/search solana ${sol}`, `/analyze solana ${sol}`, sol, '/other']) {
      assert.equal(await handleBotCommand(input, h.context), false);
    }
    assert.equal(h.messages.length, 0);
  });

  test('lists are escaped, paginated and navigable without dropping results', async () => {
    const h = harness(() => Array.from({ length: 7 }, (_, i) => ({ label: i === 0 ? '<script>&' : `wallet ${i}`, chain_network: 'solana', wallet_address: sol })));
    await handleBotCommand('/watchlist', h.context);
    assert.match(h.messages[0].html, /&lt;script&gt;&amp;/);
    assert.doesNotMatch(h.messages[0].html, /<script>/);
    assert.equal(h.messages[0].keyboard?.[0][0].callback_data, 'cmd:/watchlist 2');
    await handleBotCommand('/watchlist 2', h.context);
    assert.match(h.messages[1].html, /wallet 6/);
    assert.doesNotMatch(h.messages[0].html, /wallet 6/);
  });

  test('deletes require confirmation and use exact stored chain and address', async () => {
    const h = harness((_path, init) => init ? { success: true } : [
      { chain_network: 'Solana', contract_address: sol },
      { chain_network: 'ethereum', contract_address: evm.toLowerCase() },
    ]);
    const command = `/delcoin solana ${sol}`;
    await handleBotCommand(command, h.context);
    assert.deepEqual(h.confirmations, [command]);
    assert.equal(h.calls.length, 0);
    assert.equal(h.messages[0].keyboard?.[0][0].callback_data, 'confirm:token');
    h.context.confirmed = true;
    await handleBotCommand(command, h.context);
    assert.equal(h.calls[1].init?.method, 'DELETE');
    assert.deepEqual(JSON.parse(String(h.calls[1].init?.body)), { chain_network: 'Solana', contract_address: sol });
  });

  test('rename and pin are scoped to existing chain identity', async () => {
    const h = harness((_path, init) => init ? { success: true } : [{ chain_network: 'Ethereum', wallet_address: evm }]);
    await handleBotCommand(`/renamewallet ethereum ${evm} Alice & Bob`, h.context);
    assert.equal(h.calls[1].init?.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(h.calls[1].init?.body)), { chain_network: 'Ethereum', wallet_address: evm, label: 'Alice & Bob' });
    await handleBotCommand(`/pinwallet ethereum ${evm} on`, h.context);
    assert.equal(JSON.parse(String(h.calls[3].init?.body)).is_primary, true);
  });

  test('coin label, blacklist, whitelist and settings mutations use correct payloads', async () => {
    const h = harness((_path, init) => init ? { success: true } : [{ chain_network: 'solana', contract_address: sol }]);
    await handleBotCommand(`/renamecoin solana ${sol} New name`, h.context);
    assert.deepEqual(JSON.parse(String(h.calls[1].init?.body)), { chain_network: 'solana', contract_address: sol, label: 'New name' });
    await handleBotCommand(`/block solana ${sol} Blocked`, h.context);
    await handleBotCommand(`/allow solana ${sol} Allowed`, h.context);
    await handleBotCommand('/set ENABLE_COIN_SCANNER true', h.context);
    assert.equal(h.calls[2].path, '/api/blacklist');
    assert.equal(h.calls[3].path, '/api/whitelist');
    assert.deepEqual(JSON.parse(String(h.calls[4].init?.body)), { key: 'ENABLE_COIN_SCANNER', value: 'true' });
    await handleBotCommand('/set SECRET true', h.context);
    assert.equal(h.calls.length, 5);
  });

  test('all destructive commands require confirmation and preserve the selected chain', async () => {
    for (const [command, path, field] of [
      ['/delwallet', '/api/watchlist', 'wallet_address'],
      ['/unblock', '/api/blacklist', 'contract_address'],
      ['/unallow', '/api/whitelist', 'contract_address'],
    ]) {
      const h = harness((_path, init) => init ? { success: true } : [{ chain_network: 'BSC', [field]: evm }]);
      const input = `${command} bsc ${evm}`;
      await handleBotCommand(input, h.context);
      assert.equal(h.calls.length, 0);
      h.context.confirmed = true;
      await handleBotCommand(input, h.context);
      assert.equal(h.calls[1].path, path);
      assert.deepEqual(JSON.parse(String(h.calls[1].init?.body)), { chain_network: 'BSC', [field]: evm });
    }
  });

  test('ambiguous stored identities cannot be mutated', async () => {
    const h = harness(() => [{ chain_network: 'Solana', contract_address: sol }, { chain_network: 'solana', contract_address: sol }]);
    await handleBotCommand(`/renamecoin solana ${sol} Name`, h.context);
    assert.equal(h.calls.length, 1);
    assert.match(h.messages[0].html, /tidak tersedia/);
  });

  test('holders expose provider coverage and indicators expose timeframe', async () => {
    const h = harness(path => path.startsWith('/api/holders')
      ? { source: 'Rugcheck', coverage: 'Reported accounts', holders: [{ address: sol, share: null }] }
      : { rsi: null, macd: null, timeframe: 'hour' });
    await handleBotCommand(`/holders solana ${sol}`, h.context);
    assert.match(h.messages[0].html, /Reported accounts/);
    assert.match(h.messages[1].html, /share: unavailable/);
    await handleBotCommand(`/indicators solana ${sol}`, h.context);
    assert.match(h.messages[2].html, /Timeframe: hour/);
  });

  test('invalid addresses, unsupported chains and unsafe pin values do not mutate', async () => {
    const h = harness();
    for (const command of ['/addcoin solana invalid label', `/delwallet other ${evm}`, `/pincoin solana ${sol} yes`, '/watchlist 0']) {
      await handleBotCommand(command, h.context);
    }
    assert.equal(h.calls.length, 0);
    assert.equal(h.confirmations.length, 0);
  });

  test('history does not turn provider BUY into a proven swap and remains pageable', async () => {
    const h = harness(() => ({ history: Array.from({ length: 6 }, (_, i) => ({ type: 'BUY', amount: i })) }));
    await handleBotCommand(`/history solana ${sol} ${sol}`, h.context);
    assert.match(h.messages[0].html, /bukan bukti swap/);
    assert.match(h.messages[0].html, /UNKNOWN/);
    assert.doesNotMatch(h.messages[0].html, /BUY/);
    assert.match(h.messages[0].html, /Halaman lain:/);
    assert.equal(h.messages[0].keyboard, undefined);
    await handleBotCommand(`/history solana ${sol} ${sol} 2`, h.context);
    assert.match(h.messages[1].html, /amount: 5/);
  });

  test('portfolio forwards page and emits every returned record', async () => {
    const h = harness(() => ({ tokens: Array.from({ length: 8 }, (_, i) => ({ symbol: `token${i}` })), hasNextPage: true }));
    await handleBotCommand(`/portfolio solana ${sol} 2`, h.context);
    assert.deepEqual(JSON.parse(String(h.calls[0].init?.body)), { chain_network: 'solana', wallet_address: sol, page: 2 });
    assert.equal(h.messages.length, 2);
    assert.match(h.messages[1].html, /token7/);
  });

  test('provider errors and exceptions never leak details', async () => {
    const h = harness(() => Response.json({ error: 'private provider secret' }, { status: 500 }));
    await handleBotCommand(`/holders solana ${sol}`, h.context);
    assert.match(h.messages[0].html, /tidak tersedia/);
    assert.doesNotMatch(h.messages[0].html, /private provider secret/);
    h.context.api = async () => { throw new Error('credential'); };
    await handleBotCommand('/settings', h.context);
    assert.doesNotMatch(h.messages[1].html, /credential/);
  });

});
