import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Interface } from 'ethers';

/**
 * Deterministic Native-Process Integration Smoke Suite.
 * Launches actual scripts/bot.ts via Node24 --experimental-strip-types,
 * with network calls redirected to this parent fixture HTTP server.
 * Replaces the flaky, production-touching legacy integration tests.
 */

interface FixtureState {
  jobs: Map<string, { id: string; kind: string; payload: Record<string, unknown>; status: string; attempts: number; run_after: string; lease_until: string | null; created_at: string }>;
  confirmations: Map<string, { token: string; command: string; user_id: string; chat_id: string; expires_at: string; claimed_update_id: number | null }>;
  botState: Map<string, unknown>;
  watchlist: Map<string, { wallet_address: string; chain_network: string; label?: string; created_at: string }>;
  trackedCoins: Map<string, { contract_address: string; chain_network: string; label?: string; created_at: string }>;
  blacklistTokens: Map<string, { contract_address: string; chain_network: string; label?: string; created_at: string }>;
  whitelistTokens: Map<string, { contract_address: string; chain_network: string; label?: string; created_at: string }>;
  appSettings: Map<string, { key: string; value: string }>;
  paperTrades: Map<string, { signal_id: string; user_id: string; chat_id: string; entry_at: string; trade: Record<string, unknown> }>;
  tradeOrders: Map<string, { id: string; user_id: string; chat_id: string; quote: Record<string, unknown>; quote_hash: string; notional_usd: string; mode: string; status: string; expires_at: string; confirmed_update_id: number | null; execution_token: string | null; lease_until: string | null; risk_reserved_usd: string; tx_hash: string | null; signed_payload: string | null; last_error: string | null; created_at: string }>;
  tradeRisk: { killed: boolean; reason: string | null; used_usd: string };
  telegramCalls: { method: string; payload: Record<string, unknown> }[];
  failJobsUpsert: boolean;
  cleanupFailures: number;
  cleanupCalls: { id: string; attempt: number; batch: number }[];
  nextMsgId: number;
}

const state: FixtureState = {
  jobs: new Map(),
  confirmations: new Map(),
  botState: new Map(),
  watchlist: new Map(),
  trackedCoins: new Map(),
  blacklistTokens: new Map(),
  whitelistTokens: new Map(),
  appSettings: new Map(),
  paperTrades: new Map(),
  tradeOrders: new Map(),
  tradeRisk: { killed: false, reason: null, used_usd: '0' },
  telegramCalls: [],
  failJobsUpsert: false,
  cleanupFailures: 1,
  cleanupCalls: [],
  nextMsgId: 100,
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Integration test exercising external child process over TCP loopback requires polling retry ticks against real socket.
async function getFreePort(): Promise<number> {
  const { promise, resolve: resolvePort, reject } = Promise.withResolvers<number>();
  const srv = createServer();
  srv.listen(0, '127.0.0.1', () => {
    const addr = srv.address() as AddressInfo;
    srv.close(err => (err ? reject(err) : resolvePort(addr.port)));
  });
  return promise;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 30000, intervalMs = 60): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    // Integration test polling external child process side-effects against loopback HTTP fixture
    await delay(intervalMs);
  }
  throw new Error(`Condition timed out after ${timeoutMs}ms`);
}

async function waitForHealthy(port: number, child?: ChildProcess, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child && child.exitCode !== null) {
      throw new Error(`Bot process exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { ready?: boolean } | null;
        if (body?.ready === true) return;
      }
    } catch {
      // Polling external child process until TCP listener is bound
    }
    await delay(100);
  }
  throw new Error(`Bot service failed to report healthy on port ${port} within ${timeoutMs}ms (child exitCode: ${child?.exitCode})`);
}

function filterRows<T extends Record<string, unknown>>(allRows: T[], searchParams: URLSearchParams): T[] {
  let rows = [...allRows];
  for (const [key, value] of searchParams.entries()) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
    if (value.startsWith('eq.')) {
      const expected = value.slice(3).toLowerCase();
      rows = rows.filter(r => {
        const val = r[key];
        return typeof val === 'string' && val.toLowerCase() === expected;
      });
    }
  }
  return rows;
}

describe('Native Process Integration Smoke Test', () => {
  let fixtureServer: Server;
  let fixturePort: number;
  let botPort: number;
  let activeBot: { child: ChildProcess; stop: () => Promise<void> } | null = null;

  const frontendDir = resolve(process.cwd().includes('frontend') ? process.cwd() : resolve(process.cwd(), 'frontend'));
  const preloadPath = resolve(frontendDir, 'test/fixtures/preload.mjs');

  const BOT_API_TOKEN = '0123456789abcdef0123456789abcdef';
  const WEBHOOK_SECRET = 'webhook_secret_1234567890_abcdefghijklmno';
  const OWNER_USER_ID = '1001';
  const UNOWNER_USER_ID = '2002';
  const ALLOWED_CHAT_ID = '-2001';
  const revision = 'a'.repeat(40);
  const instanceId = '123e4567-e89b-42d3-a456-426614174000';

  before(async () => {
    // Start parent fake PostgREST + provider proxy HTTP fixture
    fixtureServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('Content-Type', 'application/json');
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = parsedUrl.pathname;
      const method = (req.method || 'GET').toUpperCase();
      const raw = await readBody(req);

      // --- PostgREST REST endpoints for bot_jobs ---
      if (pathname === '/rest/v1/bot_jobs') {
        if (method === 'GET') {
          // store.ready() check: select=id&limit=0
          res.setHeader('Content-Range', `*/${state.jobs.size}`);
          return res.writeHead(200).end('[]');
        }
        if (method === 'POST') {
          if (state.failJobsUpsert) {
            return res.writeHead(500).end(JSON.stringify({ error: 'Simulated persistent insert error' }));
          }
          const body = JSON.parse(raw);
          const items = Array.isArray(body) ? body : [body];
          for (const item of items) {
            if (!state.jobs.has(item.id)) {
              state.jobs.set(item.id, {
                id: item.id,
                kind: item.kind,
                payload: item.payload,
                status: 'pending',
                attempts: 0,
                run_after: new Date().toISOString(),
                lease_until: null,
                created_at: new Date().toISOString(),
              });
            }
          }
          return res.writeHead(201).end(JSON.stringify(items));
        }
        if (method === 'PATCH') {
          const id = parsedUrl.searchParams.get('id')?.replace(/^eq\./, '');
          if (id && state.jobs.has(id)) {
            const patch = JSON.parse(raw);
            Object.assign(state.jobs.get(id)!, patch);
          }
          return res.writeHead(200).end('[]');
        }
      }

      if (pathname === '/rest/v1/bot_confirmations') {
        if (method === 'POST') {
          const body = JSON.parse(raw);
          state.confirmations.set(body.token, { ...body, claimed_update_id: null });
          return res.writeHead(201).end('[]');
        }
      }

      if (pathname === '/rest/v1/bot_state') {
        const key = parsedUrl.searchParams.get('key')?.replace(/^eq\./, '');
        const val = key ? state.botState.get(key) : null;
        if (req.headers['accept']?.includes('vnd.pgrst.object+json')) {
          return res.writeHead(200).end(JSON.stringify(val !== undefined ? { value: val } : null));
        }
        return res.writeHead(200).end(JSON.stringify(val !== undefined ? [{ value: val }] : []));
      }

      if (pathname === '/rest/v1/paper_trades') {
        const u = parsedUrl.searchParams.get('user_id')?.replace(/^eq\./, '');
        const c = parsedUrl.searchParams.get('chat_id')?.replace(/^eq\./, '');
        let matching = [...state.paperTrades.values()].filter(r => (!u || r.user_id === u) && (!c || r.chat_id === c));
        matching.sort((a, b) => new Date(b.entry_at).getTime() - new Date(a.entry_at).getTime());
        const limitStr = parsedUrl.searchParams.get('limit');
        const limit = limitStr ? parseInt(limitStr, 10) : matching.length;
        const rows = matching.slice(0, Number.isFinite(limit) ? limit : matching.length).map(r => ({ trade: r.trade }));
        res.setHeader('Content-Range', `${rows.length > 0 ? `0-${rows.length - 1}` : '*'}/${matching.length}`);
        return res.writeHead(200).end(JSON.stringify(rows));
      }

      if (pathname === '/rest/v1/trade_orders') {
        const id = parsedUrl.searchParams.get('id')?.replace(/^eq\./, '');
        const u = parsedUrl.searchParams.get('user_id')?.replace(/^eq\./, '');
        const c = parsedUrl.searchParams.get('chat_id')?.replace(/^eq\./, '');
        let matching = [...state.tradeOrders.values()].filter(o => (!id || o.id === id) && (!u || o.user_id === u) && (!c || o.chat_id === c));
        matching.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        const limitStr = parsedUrl.searchParams.get('limit');
        const limit = limitStr ? parseInt(limitStr, 10) : matching.length;
        const rows = matching.slice(0, Number.isFinite(limit) ? limit : matching.length);
        res.setHeader('Content-Range', `${rows.length > 0 ? `0-${rows.length - 1}` : '*'}/${matching.length}`);
        if (req.headers['accept']?.includes('vnd.pgrst.object+json')) {
          return res.writeHead(200).end(JSON.stringify(rows[0] || null));
        }
        return res.writeHead(200).end(JSON.stringify(rows));
      }

      if (pathname === '/rest/v1/trade_risk') {
        const row = { killed: state.tradeRisk.killed, reason: state.tradeRisk.reason, used_usd: state.tradeRisk.used_usd };
        if (req.headers['accept']?.includes('vnd.pgrst.object+json')) {
          return res.writeHead(200).end(JSON.stringify(row));
        }
        return res.writeHead(200).end(JSON.stringify([row]));
      }

      // --- PostgREST REST handlers for identity & entities tables with exact Content-Range ---
      const tableMap: Record<string, { map: Map<string, Record<string, unknown>>; keyFn: (r: Record<string, unknown>) => string }> = {
        '/rest/v1/watchlist': {
          map: state.watchlist,
          keyFn: r => `${r.chain_network}:${r.wallet_address}`,
        },
        '/rest/v1/tracked_coins': {
          map: state.trackedCoins,
          keyFn: r => `${r.chain_network}:${r.contract_address}`,
        },
        '/rest/v1/blacklist_tokens': {
          map: state.blacklistTokens,
          keyFn: r => `${r.chain_network}:${r.contract_address}`,
        },
        '/rest/v1/whitelist_tokens': {
          map: state.whitelistTokens,
          keyFn: r => `${r.chain_network}:${r.contract_address}`,
        },
        '/rest/v1/app_settings': {
          map: state.appSettings,
          keyFn: r => String(r.key),
        },
      };

      if (pathname in tableMap) {
        const { map, keyFn } = tableMap[pathname];

        if (method === 'GET') {
          const filtered = filterRows([...map.values()], parsedUrl.searchParams);
          const totalCount = filtered.length;
          let result = filtered;
          const limitStr = parsedUrl.searchParams.get('limit');
          if (limitStr) {
            const limit = parseInt(limitStr, 10);
            if (Number.isFinite(limit)) result = result.slice(0, limit);
          }
          // Supabase resolveStoredIdentity requires Content-Range to obtain count: 'exact'
          res.setHeader('Content-Range', `${result.length > 0 ? `0-${result.length - 1}` : '*'}/${totalCount}`);
          return res.writeHead(200).end(JSON.stringify(result));
        }

        if (method === 'POST') {
          const body = JSON.parse(raw);
          const items = Array.isArray(body) ? body : [body];
          for (const item of items) {
            map.set(keyFn(item), { ...item, created_at: new Date().toISOString() });
          }
          res.setHeader('Content-Range', `${items.length > 0 ? `0-${items.length - 1}` : '*'}/${items.length}`);
          return res.writeHead(201).end(JSON.stringify(items));
        }

        if (method === 'DELETE') {
          const matching = filterRows([...map.values()], parsedUrl.searchParams);
          for (const row of matching) {
            map.delete(keyFn(row));
          }
          // Real PostgREST returns representation of deleted rows with Content-Range
          res.setHeader('Content-Range', `${matching.length > 0 ? `0-${matching.length - 1}` : '*'}/${matching.length}`);
          return res.writeHead(200).end(JSON.stringify(matching));
        }

        if (method === 'PATCH') {
          const patch = JSON.parse(raw);
          const matching = filterRows([...map.values()], parsedUrl.searchParams);
          for (const row of matching) {
            Object.assign(row, patch);
          }
          res.setHeader('Content-Range', `${matching.length > 0 ? `0-${matching.length - 1}` : '*'}/${matching.length}`);
          return res.writeHead(200).end(JSON.stringify(matching));
        }
      }

      // --- PostgREST RPC procedures ---
      if (pathname === '/rest/v1/rpc/bot_claim_job') {
        const now = Date.now();
        let claimedJob: unknown = null;
        for (const job of state.jobs.values()) {
          const leaseUntil = job.lease_until ? new Date(job.lease_until).getTime() : 0;
          const runAfter = job.run_after ? new Date(job.run_after).getTime() : 0;
          if (
            job.attempts < 4 &&
            ((job.status === 'pending' && runAfter <= now) ||
              (job.status === 'running' && leaseUntil <= now))
          ) {
            job.status = 'running';
            job.attempts += 1;
            job.lease_until = new Date(now + 180000).toISOString();
            claimedJob = job;
            break;
          }
        }
        return res.writeHead(200).end(JSON.stringify(claimedJob ? [claimedJob] : []));
      }

      if (pathname === '/rest/v1/rpc/bot_has_lease') {
        return res.writeHead(200).end(JSON.stringify(true));
      }
      if (pathname === '/rest/v1/rpc/bot_cleanup_retention') {
        const { p_id, p_attempt, p_batch } = JSON.parse(raw);
        state.cleanupCalls.push({ id: p_id, attempt: p_attempt, batch: p_batch });
        const job = state.jobs.get(p_id);
        if (!job || job.kind !== 'maintenance' || job.status !== 'running' || job.attempts !== p_attempt || p_batch !== 5000) {
          return res.writeHead(403).end(JSON.stringify({ error: 'Invalid maintenance fence' }));
        }
        if (state.cleanupFailures > 0) {
          state.cleanupFailures--;
          return res.writeHead(500).end(JSON.stringify({ error: 'Simulated cleanup failure' }));
        }
        return res.writeHead(200).end(JSON.stringify({ deletedJobs: 0, compactedJobs: 0, deletedConfirmations: 0 }));
      }


      if (pathname === '/rest/v1/rpc/bot_renew_job') {
        return res.writeHead(200).end(JSON.stringify(true));
      }

      if (pathname === '/rest/v1/rpc/bot_write_state') {
        const { p_key, p_value } = JSON.parse(raw);
        if (p_key) state.botState.set(p_key, p_value);
        return res.writeHead(200).end('null');
      }

      if (pathname === '/rest/v1/rpc/bot_take_confirmation') {
        const { p_token, p_user, p_chat, p_update } = JSON.parse(raw);
        const conf = state.confirmations.get(p_token);
        if (conf && conf.user_id === String(p_user) && conf.chat_id === String(p_chat)) {
          const expiresAt = new Date(conf.expires_at).getTime();
          if (!conf.claimed_update_id && expiresAt > Date.now()) {
            conf.claimed_update_id = Number(p_update);
            return res.writeHead(200).end(JSON.stringify([conf]));
          }
          if (conf.claimed_update_id === Number(p_update)) {
            return res.writeHead(200).end(JSON.stringify([conf]));
          }
        }
        return res.writeHead(200).end('[]');
      }

      if (pathname === '/rest/v1/rpc/paper_open') {
        const { p_trade } = JSON.parse(raw);
        if (!p_trade || !p_trade.signalId) return res.writeHead(400).end(JSON.stringify({ error: 'Invalid paper trade' }));
        const existing = state.paperTrades.get(p_trade.signalId);
        if (existing) {
          if (existing.user_id === p_trade.actor.userId && existing.chat_id === p_trade.actor.chatId) {
            return res.writeHead(200).end(JSON.stringify(existing.trade));
          }
          return res.writeHead(500).end(JSON.stringify({ error: 'Paper signal belongs to another actor' }));
        }
        state.paperTrades.set(p_trade.signalId, {
          signal_id: p_trade.signalId,
          user_id: p_trade.actor.userId,
          chat_id: p_trade.actor.chatId,
          entry_at: p_trade.entryAt,
          trade: p_trade,
        });
        return res.writeHead(200).end(JSON.stringify(p_trade));
      }

      if (pathname === '/rest/v1/rpc/paper_due') {
        return res.writeHead(200).end('[]');
      }

      if (pathname === '/rest/v1/rpc/paper_settle') {
        return res.writeHead(200).end('null');
      }

      if (pathname === '/rest/v1/rpc/trade_create') {
        const { p_id, p_user, p_chat, p_quote, p_hash, p_notional, p_mode } = JSON.parse(raw);
        if (!state.tradeOrders.has(p_id)) {
          state.tradeOrders.set(p_id, {
            id: p_id,
            user_id: String(p_user),
            chat_id: String(p_chat),
            quote: p_quote,
            quote_hash: String(p_hash),
            notional_usd: String(p_notional),
            mode: String(p_mode),
            status: 'quoted',
            expires_at: p_quote.expiresAt,
            confirmed_update_id: null,
            execution_token: null,
            lease_until: null,
            risk_reserved_usd: '0',
            tx_hash: null,
            signed_payload: null,
            last_error: null,
            created_at: new Date().toISOString(),
          });
        }
        return res.writeHead(200).end('null');
      }

      if (pathname === '/rest/v1/rpc/trade_confirm') {
        const { p_id, p_user, p_chat, p_update } = JSON.parse(raw);
        const order = state.tradeOrders.get(p_id);
        if (!order || order.user_id !== String(p_user) || order.chat_id !== String(p_chat)) {
          return res.writeHead(200).end('false');
        }
        if (order.confirmed_update_id === Number(p_update)) {
          return res.writeHead(200).end('true');
        }
        if (order.status !== 'quoted' || order.confirmed_update_id !== null || new Date(order.expires_at).getTime() <= Date.now()) {
          return res.writeHead(200).end('false');
        }
        order.status = 'confirmed';
        order.confirmed_update_id = Number(p_update);
        return res.writeHead(200).end('true');
      }

      if (pathname === '/rest/v1/rpc/trade_set_kill') {
        const { p_killed, p_reason } = JSON.parse(raw);
        state.tradeRisk.killed = Boolean(p_killed);
        state.tradeRisk.reason = p_reason ? String(p_reason).slice(0, 200) : null;
        return res.writeHead(200).end('null');
      }

      if (pathname === '/rest/v1/rpc/trade_claim') {
        return res.writeHead(200).end('[]');
      }

      if (pathname === '/rest/v1/rpc/trade_reserve') {
        return res.writeHead(200).end('true');
      }

      if (pathname === '/rest/v1/rpc/trade_write_signed') {
        const { p_id, p_payload, p_hash } = JSON.parse(raw);
        const order = state.tradeOrders.get(p_id);
        if (order) {
          order.signed_payload = String(p_payload);
          order.tx_hash = String(p_hash);
          order.status = 'signed';
        }
        return res.writeHead(200).end('null');
      }

      if (pathname === '/rest/v1/rpc/trade_transition') {
        const { p_id, p_status, p_error } = JSON.parse(raw);
        const order = state.tradeOrders.get(p_id);
        if (order) {
          order.status = String(p_status);
          order.last_error = p_error ? String(p_error) : null;
        }
        return res.writeHead(200).end('null');
      }

      // --- Intercepted external provider proxy ---
      if (pathname === '/proxy') {
        const originalUrl = req.headers['x-intercepted-url'] || parsedUrl.searchParams.get('url') || '';
        const urlStr = String(originalUrl);

        if (urlStr.includes('api.telegram.org')) {
          const methodMatch = urlStr.split('/').pop() || '';
          const payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          state.telegramCalls.push({ method: methodMatch, payload });

          if (methodMatch === 'sendMessage') {
            return res.writeHead(200).end(JSON.stringify({ ok: true, result: { message_id: state.nextMsgId++ } }));
          }
          if (methodMatch === 'editMessageText') {
            return res.writeHead(200).end(JSON.stringify({ ok: true, result: { message_id: payload.message_id || 1 } }));
          }
          if (methodMatch === 'answerCallbackQuery') {
            return res.writeHead(200).end(JSON.stringify({ ok: true, result: true }));
          }
          if (methodMatch === 'getWebhookInfo') {
            return res.writeHead(200).end(JSON.stringify({ ok: true, result: { url: '' } }));
          }
          return res.writeHead(200).end(JSON.stringify({ ok: true, result: true }));
        }

        if (urlStr.includes('dexscreener')) {
          const parts = urlStr.split('/');
          const tokenAddr = parts.pop()?.split('?')[0] || '0x3333333333333333333333333333333333333333';
          const chain = parts.pop() || 'ethereum';
          const isSol = chain === 'solana';
          return res.writeHead(200).end(
            JSON.stringify([
              {
                chainId: chain,
                baseToken: { address: tokenAddr, symbol: isSol ? 'SOL' : 'AUDT' },
                quoteToken: { address: isSol ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', symbol: isSol ? 'USDC' : 'ETH' },
                priceUsd: '150.00',
                liquidity: { usd: 1000000, base: 50000, quote: 500000 },
                marketCap: 70000000,
                pairAddress: isSol ? 'pool_solana_1' : '0xpool_evm_1',
                dexId: isSol ? 'raydium' : 'uniswap',
                labels: isSol ? ['cpmm'] : [],
                updatedAt: new Date().toISOString(),
              },
            ])
          );
        }

        if (urlStr.includes('rugcheck')) {
          return res.writeHead(200).end(
            JSON.stringify({
              token: { supply: '1000000000', decimals: 9, mintAuthority: null, freezeAuthority: null },
              tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
              score: 100,
              risks: [],
              totalHolders: 100,
              topHolders: [{ owner: 'H1', address: 'A1', pct: 5, uiAmount: 50000000 }],
              lastUpdated: new Date().toISOString(),
            })
          );
        }

        if (urlStr.includes('gopluslabs.io')) {
          const parsed = new URL(urlStr);
          const targetToken = (parsed.searchParams.get('contract_addresses') || '0x3333333333333333333333333333333333333333').toLowerCase();
          return res.writeHead(200).end(
            JSON.stringify({
              code: 1,
              result: {
                [targetToken]: {
                  is_open_source: '1',
                  is_honeypot: '0',
                  is_mintable: '0',
                  is_proxy: '0',
                  can_take_back_ownership: '0',
                  buy_tax: '0',
                  sell_tax: '0',
                  holder_count: '100',
                  holders: [{ address: '0x1111111111111111111111111111111111111111', percent: 0.05 }],
                },
              },
            })
          );
        }

        if (urlStr.includes('0x.org') || urlStr.includes('allowance-holder/quote')) {
          const parsed = new URL(urlStr);
          const sellToken = parsed.searchParams.get('sellToken') || '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
          const buyToken = parsed.searchParams.get('buyToken') || '0x3333333333333333333333333333333333333333';
          const sellAmount = parsed.searchParams.get('sellAmount') || '1000000000000000000';
          const taker = parsed.searchParams.get('taker') || '0x1111111111111111111111111111111111111111';
          const slippageBps = Number(parsed.searchParams.get('slippageBps') || '100');

          const buyAmount = '1000000000000000000';
          const minBuyAmount = (BigInt(buyAmount) * BigInt(10000 - slippageBps) / 10000n).toString();
          const HOLDER_ADDR = '0x0000000000001fF3684f28c67538d4D072C22734';
          const SETTLER_ADDR = '0x4444444444444444444444444444444444444444';

          const holderInterface = new Interface(['function exec(address operator,address token,uint256 amount,address target,bytes data)']);
          const settlerInterface = new Interface(['function execute((address recipient,address buyToken,uint256 minAmountOut),bytes[],bytes32)']);
          const innerData = settlerInterface.encodeFunctionData('execute', [
            [taker, buyToken, BigInt(minBuyAmount)],
            [],
            '0x' + '00'.repeat(32),
          ]);
          const calldata = holderInterface.encodeFunctionData('exec', [
            SETTLER_ADDR,
            sellToken,
            BigInt(sellAmount),
            SETTLER_ADDR,
            innerData,
          ]);

          return res.writeHead(200).end(
            JSON.stringify({
              liquidityAvailable: true,
              mode: 'exact-in',
              sellToken,
              buyToken,
              sellAmount,
              buyAmount,
              minBuyAmount,
              allowanceTarget: HOLDER_ADDR,
              issues: {
                simulationIncomplete: false,
                invalidSourcesPassed: [],
                balance: null,
                allowance: null,
              },
              transaction: {
                to: HOLDER_ADDR,
                from: taker,
                data: calldata,
                value: sellToken.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ? sellAmount : '0',
                gas: '50000',
                gasPrice: '1000000000',
              },
            })
          );
        }

        if (urlStr.includes('coingecko.com')) {
          return res.writeHead(200).end(
            JSON.stringify({
              ethereum: { usd: 2500 },
              solana: { usd: 150 },
            })
          );
        }

        if (urlStr.includes('11434') || urlStr.includes('ollama')) {
          // Hermes AI offline fallback
          return res.writeHead(503).end(JSON.stringify({ error: 'Hermes offline' }));
        }

        // Generic fallback for RPC balances / network pings
        return res.writeHead(200).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [] } }));
      }

      res.writeHead(404).end(JSON.stringify({ error: 'Not found in test fixture' }));
    });

    const { promise: listenPromise, resolve: resolveListen } = Promise.withResolvers<void>();
    fixtureServer.listen(0, '127.0.0.1', () => resolveListen());
    await listenPromise;
    fixturePort = (fixtureServer.address() as AddressInfo).port;

    // Launch first child bot instance
    botPort = await getFreePort();
    activeBot = launchBot(botPort, fixturePort, preloadPath, frontendDir);
    await waitForHealthy(botPort, activeBot.child);
  });

  after(async () => {
    if (activeBot) {
      await activeBot.stop();
      activeBot = null;
    }
    const { promise: closePromise, resolve: resolveClose } = Promise.withResolvers<void>();
    fixtureServer.close(() => resolveClose());
    await closePromise;
  });

  function launchBot(targetPort: number, fixPort: number, preload: string, cwd: string) {
    const child = spawn(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        '--import',
        pathToFileURL(preload).href,
        'scripts/bot.ts',
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          ENABLE_COIN_SCANNER: 'false',
          HERMES_API_URL: '',
          HERMES_MODEL: '',
          JUPITER_API_KEY: 'synthetic-jupiter-key',
          NODE_ENV: 'test',
          BOT_TRANSPORT: 'webhook',
          BOT_PORT: String(targetPort),
          BOT_REVISION: revision,
          BOT_INSTANCE_ID: instanceId,
          BOT_API_TOKEN,
          TELEGRAM_BOT_TOKEN: 'synthetic_telegram_bot_token_123',
          TELEGRAM_ALLOWED_USER_IDS: `${OWNER_USER_ID}, ${UNOWNER_USER_ID}`,
          TELEGRAM_ALLOWED_CHAT_IDS: ALLOWED_CHAT_ID,
          TELEGRAM_CHAT_ID: ALLOWED_CHAT_ID,
          TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
          SUPABASE_URL: `http://127.0.0.1:${fixPort}`,
          SUPABASE_KEY: 'synthetic_supabase_service_role_key',
          FIXTURE_PROXY_URL: `http://127.0.0.1:${fixPort}`,
          PAPER_ENABLED: 'true',
          PAPER_ENTRY_FEE_USD: '1.00',
          PAPER_EXIT_FEE_USD: '1.00',
          PAPER_SLIPPAGE_BPS: '100',
          TRADE_EVM_TAKER: '0x1111111111111111111111111111111111111111',
          TRADE_SOLANA_TAKER: 'So11111111111111111111111111111111111111112',
          ZEROX_API_KEY: 'synthetic-zerox-key',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      const { promise: exitPromise, resolve: resolveExit } = Promise.withResolvers<void>();
      child.once('exit', () => resolveExit());
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolveExit();
      }, 4000);
      await exitPromise;
      clearTimeout(timer);
    };

    return { child, stop };
  }

  test('health exposes the supplied runtime identity', async () => {
    const response = await fetch(`http://127.0.0.1:${botPort}/health`);
    const body = await response.json() as { service: string; ready: boolean; revision: string; instanceId: string };
    assert.equal(response.status, 200);
    assert.equal(body.service, 'crypto-bot');
    assert.equal(body.ready, true);
    assert.equal(body.revision, revision);
    assert.equal(body.instanceId, instanceId);
  });

  test('invalid runtime identities fail before configuration or external startup', async () => {
    for (const identity of [{ BOT_REVISION: 'ABC' }, { BOT_INSTANCE_ID: 'not-a-uuid' }]) {
      const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', 'scripts/bot.ts'], {
        cwd: frontendDir,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...identity },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let error = '';
      child.stderr!.on('data', chunk => { error += chunk; });
      const { promise, resolve: resolveExit, reject } = Promise.withResolvers<number | null>();
      child.once('error', reject);
      child.once('exit', resolveExit);
      const code = await promise;
      assert.notEqual(code, 0);
      assert.match(error, /BOT_(REVISION|INSTANCE_ID)/);
    }
  });

  test('daily maintenance retries cleanup failure and completes under its lease', async () => {
    const id = `maintenance:${new Date().toISOString().slice(0, 10)}`;
    await waitUntil(() => state.jobs.get(id)?.status === 'pending' && state.jobs.get(id)?.attempts === 1);
    assert.equal(state.cleanupCalls.length, 1);
    await waitUntil(() => state.jobs.get(id)?.status === 'done');
    assert.deepEqual(state.cleanupCalls.map(call => [call.id, call.attempt, call.batch]), [[id, 1, 5000], [id, 2, 5000]]);
  });

  // 1. Actual server 401 unauthorized API
  test('1. actual server 401 unauthorized API', async () => {
    const res = await fetch(`http://127.0.0.1:${botPort}/api/watchlist`);
    assert.equal(res.status, 401, 'Unauthenticated API call must receive HTTP 401');
    const json = (await res.json()) as { error?: string };
    assert.ok(json.error, 'Error payload must be present');
  });

  // 2. Secret 401 / invalid 400 webhook
  test('2. secret 401 / invalid 400 webhook', async () => {
    // Missing or invalid secret header -> 401
    const badSecretRes = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': 'wrong_secret_token_abcdef',
      },
      body: JSON.stringify({ update_id: 1 }),
    });
    assert.equal(badSecretRes.status, 401, 'Webhook with invalid secret must receive HTTP 401');

    // Valid secret header but malformed / invalid update -> 400
    const badShapeRes = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({ update_id: -99 }),
    });
    assert.equal(badShapeRes.status, 400, 'Malformed update payload must receive HTTP 400');
  });

  // 3. Persist-before-ACK failure 503
  test('3. persist-before-ACK failure 503', async () => {
    state.failJobsUpsert = true;
    try {
      const res = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          update_id: 88,
          message: {
            message_id: 1,
            text: '/help',
            from: { id: Number(OWNER_USER_ID), is_bot: false },
            chat: { id: Number(ALLOWED_CHAT_ID) },
          },
        }),
      });
      assert.equal(res.status, 503, 'Webhook must respond with 503 when durable persist fails');
    } finally {
      state.failJobsUpsert = false;
    }
  });

  // 4. update_id 0 /addwallet writes state through real route + owner Telegram reply
  test('4. update_id 0 /addwallet writes state through real route + owner Telegram reply', async () => {
    const testWallet = 'So11111111111111111111111111111111111111112';
    const testLabel = 'AlphaIntegrationWallet';

    const res = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 0,
        message: {
          message_id: 10,
          text: `/addwallet solana ${testWallet} ${testLabel}`,
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          chat: { id: Number(ALLOWED_CHAT_ID) },
        },
      }),
    });

    assert.equal(res.status, 200, 'Valid update_id 0 must be accepted with 200');

    // Wait for native background worker loop to claim, process, finish job and dispatch owner reply
    await waitUntil(() =>
      state.watchlist.has(`solana:${testWallet}`) &&
      state.jobs.get('update:0')?.status === 'done' &&
      state.telegramCalls.some(c => c.method === 'sendMessage' && String(c.payload.chat_id) === ALLOWED_CHAT_ID)
    );

    const saved = state.watchlist.get(`solana:${testWallet}`);
    assert.ok(saved, 'Wallet record must be written to watchlist state');
    assert.equal(saved.wallet_address, testWallet);

    const telegramReply = state.telegramCalls.find(
      c => c.method === 'sendMessage' && String(c.payload.chat_id) === ALLOWED_CHAT_ID
    );
    assert.ok(telegramReply, 'Telegram confirmation reply must be dispatched to owner chat');
  });

  // 5. Replay no second mutation
  test('5. replay no second mutation', async () => {
    const testWallet = 'So11111111111111111111111111111111111111112';
    const initialWatchlistSize = state.watchlist.size;

    // Send the identical update_id 0 payload again (webhook replay)
    const res = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 0,
        message: {
          message_id: 10,
          text: `/addwallet solana ${testWallet} DuplicateLabel`,
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          chat: { id: Number(ALLOWED_CHAT_ID) },
        },
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(state.jobs.get('update:0')?.status, 'done');
    assert.equal(state.watchlist.size, initialWatchlistSize, 'Replay of completed update must not create secondary mutations');
  });

  // 6. Delete confirmation wrong actor rejected and rightful completes
  test('6. delete confirmation wrong actor rejected and rightful completes', async () => {
    const testWallet = 'So11111111111111111111111111111111111111112';
    assert.ok(state.watchlist.has(`solana:${testWallet}`), 'Wallet must exist prior to deletion test');

    // Step A: Owner requests deletion requiring confirmation
    const delReqRes = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 50,
        message: {
          message_id: 25,
          text: `/delwallet solana ${testWallet}`,
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          chat: { id: Number(ALLOWED_CHAT_ID) },
        },
      }),
    });
    assert.equal(delReqRes.status, 200);

    // Wait until bot confirmation token is persisted and update:50 finishes
    await waitUntil(() => state.confirmations.size > 0 && state.jobs.get('update:50')?.status === 'done');
    const token = [...state.confirmations.keys()][0];

    // Step B: Wrong actor clicks confirmation button -> must be rejected
    const wrongActorRes = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 51,
        callback_query: {
          id: 'cq_unauth_actor_click',
          data: `confirm:${token}`,
          from: { id: Number(UNOWNER_USER_ID), is_bot: false },
          message: { message_id: 26, chat: { id: Number(ALLOWED_CHAT_ID) } },
        },
      }),
    });
    assert.equal(wrongActorRes.status, 200);
    // Wait until callback handling finishes
    await waitUntil(() => state.jobs.get('update:51')?.status === 'done');

    // Wallet must still remain intact
    assert.ok(state.watchlist.has(`solana:${testWallet}`), 'Wallet must NOT be deleted by unauthorized confirmation attempt');

    // Step C: Rightful actor clicks confirmation button -> completes mutation
    const rightfulRes = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 52,
        callback_query: {
          id: 'cq_owner_actor_click',
          data: `confirm:${token}`,
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          message: { message_id: 26, chat: { id: Number(ALLOWED_CHAT_ID) } },
        },
      }),
    });
    assert.equal(rightfulRes.status, 200);

    // Wait until wallet is removed from state and update:52 completes
    await waitUntil(() => !state.watchlist.has(`solana:${testWallet}`) && state.jobs.get('update:52')?.status === 'done');
    assert.equal(state.watchlist.has(`solana:${testWallet}`), false, 'Wallet must be deleted after rightful confirmation');
  });

  // 7. /analyze data scorecard + offline/invalid Hermes fallback
  test('7. /analyze data scorecard + offline/invalid Hermes fallback', async () => {
    const coinAddress = 'So11111111111111111111111111111111111111112';

    const res = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 70,
        message: {
          message_id: 40,
          text: `/analyze solana ${coinAddress}`,
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          chat: { id: Number(ALLOWED_CHAT_ID) },
        },
      }),
    });
    assert.equal(res.status, 200);

    // Wait for the final editMessageText containing the Hermes offline fallback suffix
    await waitUntil(() =>
      state.telegramCalls.some(
        c => c.method === 'editMessageText' && String(c.payload.text || '').includes('AI lokal tidak tersedia/tidak lolos validasi')
      )
    );

    const finalEdit = state.telegramCalls
      .filter(c => c.method === 'editMessageText' && String(c.payload.text || '').includes('AI lokal tidak tersedia/tidak lolos validasi'))
      .at(-1);
    assert.ok(finalEdit, 'Final edit containing fallback suffix must exist');
    const text = String(finalEdit.payload.text || '');

    // Assert quantitative market fields extracted from mock provider
    assert.ok(/Harga USD:\s*150/i.test(text), 'Scorecard must display quantitative price (150)');
    assert.ok(/Likuiditas USD:\s*1000000/i.test(text), 'Scorecard must display quantitative liquidity (1000000)');
    // Assert Hermes offline fallback suffix is present
    assert.ok(text.includes('AI lokal tidak tersedia/tidak lolos validasi'), 'Offline Hermes must fall back gracefully to data-only scorecard');
  });

  // 8. Restart continues persisted queued update
  test('8. restart continues persisted queued update', async () => {
    const offlineWallet = '11111111111111111111111111111111';
    assert.equal(state.watchlist.has(`solana:${offlineWallet}`), false);

    // Stop current running child process
    if (activeBot) {
      await activeBot.stop();
      activeBot = null;
    }

    // Persist a pending job while the bot process is completely shut down
    state.jobs.set('update:999', {
      id: 'update:999',
      kind: 'update',
      payload: {
        update_id: 999,
        message: {
          message_id: 90,
          text: `/addwallet solana ${offlineWallet} QueuedDuringRestart`,
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          chat: { id: Number(ALLOWED_CHAT_ID) },
        },
      },
      status: 'pending',
      attempts: 0,
      run_after: new Date().toISOString(),
      lease_until: null,
      created_at: new Date().toISOString(),
    });

    // Launch a new child bot process on a new ephemeral port pointing to the same persistent state
    botPort = await getFreePort();
    activeBot = launchBot(botPort, fixturePort, preloadPath, frontendDir);
    const maintenanceCalls = state.cleanupCalls.length;
    await waitForHealthy(botPort, activeBot.child);

    // Verify newly launched process claims and executes the pre-existing pending job
    await waitUntil(() =>
      state.watchlist.has(`solana:${offlineWallet}`) &&
      state.jobs.get('update:999')?.status === 'done'
    );
    assert.ok(state.watchlist.has(`solana:${offlineWallet}`), 'Restarted bot must resume and complete persisted queued work');
    assert.equal(state.cleanupCalls.length, maintenanceCalls, 'Restart must deduplicate the same UTC-day maintenance job');
  });

  // 9. /paper open persists and replay deduplicates
  test('9. /paper open persists and replay deduplicates', async () => {
    const coin = '0x3333333333333333333333333333333333333333';
    const res = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 100,
        message: {
          message_id: 100,
          text: `/paper open ethereum ${coin} 100`,
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          chat: { id: Number(ALLOWED_CHAT_ID) },
        },
      }),
    });
    assert.equal(res.status, 200);

    await waitUntil(() =>
      state.jobs.get('update:100')?.status === 'done' &&
      state.paperTrades.size > 0
    );

    const signalId = `manual:${ALLOWED_CHAT_ID}:100`;
    const saved = state.paperTrades.get(signalId);
    assert.ok(saved, 'Paper trade record must be stored');
    assert.equal(saved.trade.notionalUsd, '100');
    assert.equal(saved.trade.entryFeeUsd, '1.00');
    const initialCount = state.paperTrades.size;

    // Replay exact update: must deduplicate and not insert second trade
    const replayRes = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 100,
        message: {
          message_id: 100,
          text: `/paper open ethereum ${coin} 100`,
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          chat: { id: Number(ALLOWED_CHAT_ID) },
        },
      }),
    });
    assert.equal(replayRes.status, 200);
    assert.equal(state.paperTrades.size, initialCount, 'Replayed paper trade must deduplicate');
  });

  // 10. /paper stats missing marks displayed as UNKNOWN
  test('10. /paper stats missing marks displayed as UNKNOWN', async () => {
    const res = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 110,
        message: {
          message_id: 110,
          text: '/paper 24h',
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          chat: { id: Number(ALLOWED_CHAT_ID) },
        },
      }),
    });
    assert.equal(res.status, 200);

    await waitUntil(() =>
      state.jobs.get('update:110')?.status === 'done' &&
      state.telegramCalls.some(c =>
        c.method === 'sendMessage' &&
        String(c.payload.chat_id) === ALLOWED_CHAT_ID &&
        String(c.payload.text || '').includes('Paper 24h')
      )
    );

    const reply = state.telegramCalls.find(
      c =>
        c.method === 'sendMessage' &&
        String(c.payload.chat_id) === ALLOWED_CHAT_ID &&
        String(c.payload.text || '').includes('Paper 24h')
    );
    assert.ok(reply);
    const text = String(reply.payload.text || '');
    assert.ok(text.includes('missing 1'), 'Unevaluated open trade must be marked missing 1');
    assert.ok(text.includes('UNKNOWN'), 'Missing marks must result in UNKNOWN performance metrics');
  });

  // 11. /quote on valid synthetic audited token stores quote and 30sec minreceived and fees
  test('11. /quote on valid synthetic audited token stores quote and 30sec minreceived and fees', async () => {
    const coin = '0x3333333333333333333333333333333333333333';
    const res = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 120,
        message: {
          message_id: 120,
          text: `/quote ethereum native ${coin} 1000000000000000000 500 100`,
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          chat: { id: Number(ALLOWED_CHAT_ID) },
        },
      }),
    });
    assert.equal(res.status, 200);

    await waitUntil(() =>
      state.jobs.get('update:120')?.status === 'done' &&
      state.tradeOrders.size > 0 &&
      state.confirmations.size > 0
    );

    const order = [...state.tradeOrders.values()][0];
    assert.ok(order, 'Trade order must be stored');
    assert.equal(order.status, 'quoted');
    assert.equal(order.notional_usd, '500');
    assert.equal(order.quote.amountRaw, '1000000000000000000');
    assert.equal(order.quote.minOutRaw, '990000000000000000');
    assert.equal(order.quote.feeNativeRaw, '50000000000000');

    const durationMs = new Date(order.expires_at).getTime() - new Date(order.quote.createdAt as string).getTime();
    assert.equal(durationMs, 30000, 'Quote lifetime must be exactly 30 seconds');

    const confirmationToken = [...state.confirmations.keys()][0];
    assert.ok(confirmationToken, 'Confirmation token must be generated');
  });

  // 12. quote confirmation wrong actor rejected and rightful confirms once
  test('12. quote confirmation wrong actor rejected and rightful confirms once', async () => {
    const order = [...state.tradeOrders.values()][0];
    assert.ok(order);
    assert.equal(order.status, 'quoted');

    const confirmationToken = [...state.confirmations.entries()].find(([, conf]) =>
      conf.command.includes(order.id)
    )?.[0];
    assert.ok(confirmationToken);

    // Step A: Wrong actor attempts to confirm
    const wrongActorRes = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 130,
        callback_query: {
          id: 'cq_bad_quote',
          data: `confirm:${confirmationToken}`,
          from: { id: Number(UNOWNER_USER_ID), is_bot: false },
          message: { message_id: 130, chat: { id: Number(ALLOWED_CHAT_ID) } },
        },
      }),
    });
    assert.equal(wrongActorRes.status, 200);

    await waitUntil(() => state.jobs.get('update:130')?.status === 'done');
    assert.equal(order.status, 'quoted', 'Order status must remain quoted when wrong actor attempts confirmation');

    // Step B: Rightful owner confirms
    const rightfulRes = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 131,
        callback_query: {
          id: 'cq_good_quote',
          data: `confirm:${confirmationToken}`,
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          message: { message_id: 131, chat: { id: Number(ALLOWED_CHAT_ID) } },
        },
      }),
    });
    assert.equal(rightfulRes.status, 200);

    await waitUntil(() =>
      state.jobs.get('update:131')?.status === 'done' &&
      order.status === 'confirmed'
    );
    assert.equal(order.status, 'confirmed');
    assert.equal(order.confirmed_update_id, 131);

    // Step C: Rightful confirms once (replay)
    const replayConfirmRes = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 131,
        callback_query: {
          id: 'cq_good_quote_replay',
          data: `confirm:${confirmationToken}`,
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          message: { message_id: 131, chat: { id: Number(ALLOWED_CHAT_ID) } },
        },
      }),
    });
    assert.equal(replayConfirmRes.status, 200);
    assert.equal(order.status, 'confirmed');
    assert.equal(order.confirmed_update_id, 131);
  });

  // 13. expired confirmation cannot execute
  test('13. expired confirmation cannot execute', async () => {
    const expiredToken = 'expired_conf_token_test_123456';
    state.confirmations.set(expiredToken, {
      token: expiredToken,
      command: '/trade execute 1234567890abcdef1234567890abcdef',
      user_id: OWNER_USER_ID,
      chat_id: ALLOWED_CHAT_ID,
      expires_at: new Date(Date.now() - 60000).toISOString(),
      claimed_update_id: null,
    });

    const res = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 135,
        callback_query: {
          id: 'cq_expired',
          data: `confirm:${expiredToken}`,
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          message: { message_id: 135, chat: { id: Number(ALLOWED_CHAT_ID) } },
        },
      }),
    });
    assert.equal(res.status, 200);

    await waitUntil(() => state.jobs.get('update:135')?.status === 'done');

    const rejectedMsg = state.telegramCalls.find(
      c =>
        c.method === 'sendMessage' &&
        String(c.payload.chat_id) === ALLOWED_CHAT_ID &&
        String(c.payload.text || '').includes('kedaluwarsa')
    );
    assert.ok(rejectedMsg, 'Bot must send expired confirmation warning');
  });

  // 14. /trade kill and reset actor checks
  test('14. /trade kill and reset actor checks', async () => {
    // Step A: Unauthorized actor / chat sends /trade kill
    const badRes = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 140,
        message: {
          message_id: 140,
          text: '/trade kill',
          from: { id: 9999, is_bot: false },
          chat: { id: 8888 },
        },
      }),
    });
    assert.equal(badRes.status, 200);
    assert.equal(state.tradeRisk.killed, false, 'Kill switch must not be modified by unauthorized sender');

    // Step B: Owner sends /trade kill
    const killRes = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 141,
        message: {
          message_id: 141,
          text: '/trade kill',
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          chat: { id: Number(ALLOWED_CHAT_ID) },
        },
      }),
    });
    assert.equal(killRes.status, 200);

    await waitUntil(() =>
      state.jobs.get('update:141')?.status === 'done' &&
      state.tradeRisk.killed === true
    );
    assert.equal(state.tradeRisk.killed, true);
    assert.ok(state.tradeRisk.reason);

    // Step C: Owner sends /trade reset
    const resetReqRes = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 142,
        message: {
          message_id: 142,
          text: '/trade reset',
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          chat: { id: Number(ALLOWED_CHAT_ID) },
        },
      }),
    });
    assert.equal(resetReqRes.status, 200);

    await waitUntil(() =>
      state.jobs.get('update:142')?.status === 'done' &&
      [...state.confirmations.values()].some(c => c.command === '/trade reset')
    );

    const resetToken = [...state.confirmations.entries()].find(([, c]) =>
      c.command === '/trade reset'
    )?.[0];
    assert.ok(resetToken);

    // Owner confirms reset
    const resetConfirmRes = await fetch(`http://127.0.0.1:${botPort}/api/tele-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 143,
        callback_query: {
          id: 'cq_reset_confirm',
          data: `confirm:${resetToken}`,
          from: { id: Number(OWNER_USER_ID), is_bot: false },
          message: { message_id: 143, chat: { id: Number(ALLOWED_CHAT_ID) } },
        },
      }),
    });
    assert.equal(resetConfirmRes.status, 200);

    await waitUntil(() =>
      state.jobs.get('update:143')?.status === 'done' &&
      state.tradeRisk.killed === false
    );
    assert.equal(state.tradeRisk.killed, false);
    assert.equal(state.tradeRisk.used_usd, '0', 'Reset unlatches switch but never resets budget');
  });

  // 15. generic /api/settings cannot mutate LIVE or limits
  test('15. generic /api/settings cannot mutate LIVE or limits', async () => {
    const liveRes = await fetch(`http://127.0.0.1:${botPort}/api/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BOT_API_TOKEN}`,
      },
      body: JSON.stringify({ key: 'TRADE_LIVE_ENABLED', value: 'true' }),
    });
    assert.equal(liveRes.status, 400);
    const liveJson = (await liveRes.json()) as { error?: string };
    assert.ok(liveJson.error?.includes('Only ENABLE_COIN_SCANNER true|false is mutable here'));

    const maxTradeRes = await fetch(`http://127.0.0.1:${botPort}/api/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BOT_API_TOKEN}`,
      },
      body: JSON.stringify({ key: 'MAX_TRADE_USD', value: '100000' }),
    });
    assert.equal(maxTradeRes.status, 400);

    assert.equal(state.appSettings.has('TRADE_LIVE_ENABLED'), false);
    assert.equal(state.appSettings.has('MAX_TRADE_USD'), false);
  });
});
