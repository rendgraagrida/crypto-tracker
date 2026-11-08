import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  isOwner,
  updateActor,
  validUpdate,
  type TelegramUpdate,
} from '../app/lib/auth.ts';
import { createBotStore, type BotJob, type BotStore, type CleanupResult } from '../app/lib/bot-store.ts';
import {
  acceptUpdate,
  processUpdate,
  runOneJob,
} from '../app/lib/bot-runtime.ts';
import {
  classifyMovements,
  hourlySignal,
  type EnhancedTransaction,
} from '../app/lib/scanner.ts';
import { TelegramError } from '../app/lib/telegram.ts';

/**
 * Isolated in-memory FakeBotStore.
 * Mimics Postgres durable queue, state table, and atomic token consumption
 * without connecting to Supabase or network services.
 */
class FakeBotStore implements BotStore {
  readonly jobs = new Map<
    string,
    BotJob & { status: 'pending' | 'running' | 'done' | 'failed'; runAfter: number; leaseUntil?: number }
  >();
  readonly state = new Map<string, unknown>();
  readonly confirmations = new Map<
    string,
    { token: string; command: string; userId: string; chatId: string; expiresAt: number; claimedUpdateId?: number | null }
  >();
  readonly finishedJobs: BotJob[] = [];
  readonly retriedJobs: { job: BotJob; delaySeconds?: number }[] = [];
  active: BotJob | null = null;
  simulateLeaseLoss = false;
  cleanupResult: CleanupResult = { deletedJobs: 0, compactedJobs: 0, deletedConfirmations: 0 };
  cleanupCalls = 0;

  async enqueue(id: string, kind: BotJob['kind'], payload: Record<string, unknown>): Promise<void> {
    if (!this.jobs.has(id)) {
      this.jobs.set(id, { id, kind, payload, attempts: 0, status: 'pending', runAfter: Date.now() });
    }
  }

  async claim(): Promise<BotJob | null> {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (
        job.attempts < 4 &&
        ((job.status === 'pending' && job.runAfter <= now) ||
          (job.status === 'running' && (job.leaseUntil ?? 0) < now))
      ) {
        job.status = 'running';
        job.attempts += 1;
        job.leaseUntil = now + 180000;
        this.active = { id: job.id, kind: job.kind, payload: job.payload, attempts: job.attempts };
        return this.active;
      }
    }
    return null;
  }

  async ensureLease(): Promise<void> {
    if (!this.active) throw new Error('Pekerjaan tidak memiliki lease.');
    if (this.simulateLeaseLoss) throw new Error('Lease pekerjaan sudah berakhir.');
    const job = this.jobs.get(this.active.id);
    if (!job || job.status !== 'running' || (job.leaseUntil ?? 0) <= Date.now()) {
      throw new Error('Lease pekerjaan sudah berakhir.');
    }
  }
  async cleanup(): Promise<CleanupResult> {
    await this.ensureLease();
    this.cleanupCalls++;
    return this.cleanupResult;
  }


  fence() {
    if (!this.active) throw new Error('Pekerjaan tidak memiliki lease.');
    return { jobId: this.active.id, attempt: this.active.attempts };
  }

  async renew(job: BotJob): Promise<void> {
    if (this.simulateLeaseLoss) throw new Error('Lease pekerjaan sudah berakhir.');
    const existing = this.jobs.get(job.id);
    if (!existing || existing.status !== 'running' || (existing.leaseUntil ?? 0) <= Date.now()) {
      throw new Error('Lease pekerjaan sudah berakhir.');
    }
    existing.leaseUntil = Date.now() + 180000;
  }

  async finish(job: BotJob): Promise<void> {
    const existing = this.jobs.get(job.id);
    if (existing) {
      existing.status = 'done';
      existing.leaseUntil = undefined;
    }
    this.finishedJobs.push(job);
    if (this.active?.id === job.id) this.active = null;
  }

  async retry(job: BotJob, delaySeconds?: number): Promise<void> {
    const existing = this.jobs.get(job.id);
    const delay =
      delaySeconds !== undefined
        ? Math.max(1, Math.min(delaySeconds, 3600))
        : Math.min(60, 2 ** job.attempts);
    if (existing) {
      existing.status = job.attempts >= 4 ? 'failed' : 'pending';
      existing.runAfter = Date.now() + delay * 1000;
      existing.leaseUntil = undefined;
    }
    this.retriedJobs.push({ job, delaySeconds });
    if (this.active?.id === job.id) this.active = null;
  }

  async getState<T>(key: string): Promise<T | null> {
    return (this.state.get(key) as T) ?? null;
  }

  async setState(key: string, value: unknown): Promise<void> {
    this.state.set(key, value);
  }

  async confirm(command: string, userId: string, chatId: string): Promise<string> {
    const token = randomBytes(16).toString('hex');
    this.confirmations.set(token, {
      token,
      command,
      userId,
      chatId,
      expiresAt: Date.now() + 120000,
      claimedUpdateId: null,
    });
    return token;
  }

  async consumeConfirmation(token: string, userId: string, chatId: string, updateId: number): Promise<string | null> {
    if (!/^[a-f0-9]{32}$/.test(token)) return null;
    const entry = this.confirmations.get(token);
    if (!entry) return null;
    if (entry.userId !== userId || entry.chatId !== chatId) return null;
    if (entry.claimedUpdateId !== null && entry.claimedUpdateId !== undefined) {
      // Same update retry can resume; different update cannot reuse
      return entry.claimedUpdateId === updateId ? entry.command : null;
    }
    if (entry.expiresAt <= Date.now()) {
      return null;
    }
    // Durable binding to update_id
    entry.claimedUpdateId = updateId;
    return entry.command;
  }

  async ready(): Promise<boolean> {
    return true;
  }
}

/**
 * Executes a callback within a scoped environment and global fetch wrapper,
 * guaranteeing complete restoration of process.env and globalThis.fetch upon completion.
 */
async function withTestContext<T>(
  options: {
    env?: Record<string, string | undefined>;
    fetchHandler?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  },
  fn: () => Promise<T>
): Promise<T> {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  try {
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
    if (options.fetchHandler) {
      globalThis.fetch = options.fetchHandler as typeof fetch;
    }
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    globalThis.fetch = originalFetch;
  }
}

describe('Runtime Regression & Invariant Test Suite', () => {
  describe('Authorization & Webhook Input Gate', () => {
    test('authorized sender in allowed chat only (group chat alone insufficient)', async () => {
      await withTestContext(
        {
          env: {
            TELEGRAM_ALLOWED_USER_IDS: '1001, 1002',
            TELEGRAM_ALLOWED_CHAT_IDS: '-2001',
          },
        },
        async () => {
          const store = new FakeBotStore();

          // Case 1: Authorized operator sending in the allowed group chat
          const authorizedUpdate: TelegramUpdate = {
            update_id: 101,
            message: {
              message_id: 1,
              text: '/help',
              from: { id: 1001, is_bot: false },
              chat: { id: -2001 },
            },
          };
          assert.equal(isOwner(1001, -2001), true);
          assert.deepEqual(updateActor(authorizedUpdate), { userId: '1001', chatId: '-2001' });

          const enqueued = await acceptUpdate(store, authorizedUpdate);
          assert.equal(enqueued, true);
          assert.equal(store.jobs.has('update:101'), true);

          // Case 2: Unauthorized third party sending inside the allowed group chat
          const unauthSenderInGroup: TelegramUpdate = {
            update_id: 102,
            message: {
              message_id: 2,
              text: '/help',
              from: { id: 9999, is_bot: false },
              chat: { id: -2001 },
            },
          };
          assert.equal(isOwner(9999, -2001), false, 'Group chat membership alone must not grant operator authorization');
          assert.equal(updateActor(unauthSenderInGroup), null);

          const store2 = new FakeBotStore();
          const acceptedUnauth = await acceptUpdate(store2, unauthSenderInGroup);
          assert.equal(acceptedUnauth, true, 'Webhook acknowledges receipt to prevent retry storm');
          assert.equal(store2.jobs.size, 0, 'Unauthorized update must not be enqueued');

          // Case 3: Authorized operator sending from an unapproved chat
          const operatorInWrongChat: TelegramUpdate = {
            update_id: 103,
            message: {
              message_id: 3,
              text: '/help',
              from: { id: 1001, is_bot: false },
              chat: { id: -9999 },
            },
          };
          assert.equal(isOwner(1001, -9999), false);
          assert.equal(updateActor(operatorInWrongChat), null);

          // Case 4: Bot sender is rejected regardless of user/chat IDs
          const botSender: TelegramUpdate = {
            update_id: 104,
            message: {
              message_id: 4,
              text: '/help',
              from: { id: 1001, is_bot: true },
              chat: { id: -2001 },
            },
          };
          assert.equal(updateActor(botSender), null);

          // Case 5: Malformed, non-integer, or empty identifiers fail safely
          assert.equal(isOwner(Number.NaN, -2001), false);
          assert.equal(isOwner(1001, Number.NaN), false);
          assert.equal(isOwner(1.5, -2001), false);
        }
      );
    });

    test('revoked owner queued update rejected', async () => {
      await withTestContext(
        {
          env: {
            TELEGRAM_ALLOWED_USER_IDS: '1001',
            TELEGRAM_ALLOWED_CHAT_IDS: '-2001',
            TELEGRAM_BOT_TOKEN: 'mock_token_revocation_test',
          },
        },
        async () => {
          const store = new FakeBotStore();
          const outgoingMessages: { method: string; body: unknown }[] = [];
          globalThis.fetch = async (input, init) => {
            const url = String(input);
            const method = url.split('/').pop() || '';
            const body = init?.body ? JSON.parse(String(init.body)) : {};
            outgoingMessages.push({ method, body });
            return Response.json({ ok: true, result: { message_id: 1 } });
          };

          const queuedUpdate: TelegramUpdate = {
            update_id: 201,
            message: {
              message_id: 10,
              text: '/settings ENABLE_COIN_SCANNER false',
              from: { id: 1001, is_bot: false },
              chat: { id: -2001 },
            },
          };

          // Update was enqueued when user 1001 was a valid owner
          const initialAccept = await acceptUpdate(store, queuedUpdate);
          assert.equal(initialAccept, true);
          assert.equal(store.jobs.has('update:201'), true);

          // Owner permission is revoked before queued job execution runs
          process.env.TELEGRAM_ALLOWED_USER_IDS = '2002';

          // When queued job executes, actor check fails closed
          await processUpdate(queuedUpdate, store);

          assert.equal(outgoingMessages.length, 0, 'No Telegram reply or mutation message sent for revoked actor');
          assert.equal(store.state.size, 0, 'No state modification executed by revoked actor');
        }
      );
    });

    test('webhook update_id 0 accepted', async () => {
      await withTestContext(
        {
          env: {
            TELEGRAM_ALLOWED_USER_IDS: '1001',
            TELEGRAM_ALLOWED_CHAT_IDS: '-2001',
          },
        },
        async () => {
          const store = new FakeBotStore();
          const zeroUpdate: TelegramUpdate = {
            update_id: 0,
            message: {
              message_id: 1,
              text: '/help',
              from: { id: 1001, is_bot: false },
              chat: { id: -2001 },
            },
          };

          assert.equal(validUpdate(zeroUpdate), true, 'update_id 0 must be recognized as valid');
          const accepted = await acceptUpdate(store, zeroUpdate);
          assert.equal(accepted, true);
          assert.equal(store.jobs.has('update:0'), true, 'Job must be queued using update_id 0 key');
        }
      );
    });

    test('bad shape reject', async () => {
      const store = new FakeBotStore();

      const invalidPayloads: unknown[] = [
        null,
        undefined,
        '',
        12345,
        {},
        { update_id: -1 },
        { update_id: 1.25 },
        { update_id: Number.NaN },
        { update_id: Number.POSITIVE_INFINITY },
        { update_id: 5, message: { text: 12345 } },
        { update_id: 6, message: { text: 'a'.repeat(8193) } },
        { update_id: 7, callback_query: { id: 123, data: 'action' } },
        { update_id: 8, callback_query: { id: 'cb_id', data: 'a'.repeat(65) } },
      ];

      for (const payload of invalidPayloads) {
        assert.equal(validUpdate(payload), false);
        const result = await acceptUpdate(store, payload);
        assert.equal(result, false, 'Malformed update must reject without enqueueing');
      }

      assert.equal(store.jobs.size, 0);
    });
  });


  describe('Scanner & Movement Classification', () => {
    test('same tx multiple token events distinct', () => {
      const wallet = 'WalletTestAlpha1111111111111111111111111111';
      const tokenA = 'TokenAAA111111111111111111111111111111111';
      const tokenB = 'TokenBBB111111111111111111111111111111111';
      const wsol = 'So11111111111111111111111111111111111111112';

      const multiTokenTx: EnhancedTransaction = {
        signature: 'tx_multi_token_signature_123',
        type: 'SWAP',
        events: { swap: {} },
        tokenTransfers: [
          { mint: tokenA, tokenAmount: 150, toUserAccount: wallet },
          { mint: tokenB, tokenAmount: 300, toUserAccount: wallet },
          { mint: wsol, tokenAmount: 2.5, fromUserAccount: wallet },
        ],
      };

      const movements = classifyMovements(multiTokenTx, wallet);

      assert.equal(movements.length, 2, 'Both distinct token movements must be extracted');
      assert.notEqual(movements[0].mint, movements[1].mint);
      assert.notEqual(movements[0].eventIndex, movements[1].eventIndex, 'Event indices must be unique');

      const moveA = movements.find(m => m.mint === tokenA);
      const moveB = movements.find(m => m.mint === tokenB);

      assert.ok(moveA && moveB);
      assert.equal(moveA.amount, 150);
      assert.equal(moveA.action, 'BUY');
      assert.equal(moveB.amount, 300);
      assert.equal(moveB.action, 'BUY');

    });

    test('transfer-in without SWAP remains UNKNOWN', () => {
      const wallet = 'WalletTestAlpha1111111111111111111111111111';
      const tokenA = 'TokenAAA111111111111111111111111111111111';

      // Case 1: Simple transfer or airdrop (TRANSFER type)
      const airdropTx: EnhancedTransaction = {
        signature: 'tx_airdrop_456',
        type: 'TRANSFER',
        tokenTransfers: [{ mint: tokenA, tokenAmount: 10000, toUserAccount: wallet }],
      };

      const moves1 = classifyMovements(airdropTx, wallet);
      assert.equal(moves1.length, 1);
      assert.equal(moves1[0].action, 'UNKNOWN', 'Transfer-in without SWAP must remain UNKNOWN');
      assert.equal(moves1[0].amount, 10000);

      // Case 2: SWAP type missing events.swap payload
      const unverifiedSwapTx: EnhancedTransaction = {
        signature: 'tx_unverified_swap_789',
        type: 'SWAP',
        tokenTransfers: [{ mint: tokenA, tokenAmount: 5000, toUserAccount: wallet }],
      };

      const moves2 = classifyMovements(unverifiedSwapTx, wallet);
      assert.equal(moves2[0].action, 'UNKNOWN');

      // Case 3: SWAP type and event present, but no opposite quote token or native delta paid out
      const missingQuoteTx: EnhancedTransaction = {
        signature: 'tx_missing_quote_012',
        type: 'SWAP',
        events: { swap: {} },
        tokenTransfers: [{ mint: tokenA, tokenAmount: 2500, toUserAccount: wallet }],
      };

      const moves3 = classifyMovements(missingQuoteTx, wallet);
      assert.equal(moves3[0].action, 'UNKNOWN');
    });

    test('verified swap opposite quote supports SELL incl old token', () => {
      const wallet = 'WalletTestAlpha1111111111111111111111111111';
      const oldHeldToken = 'OldHeldToken11111111111111111111111111111111';
      const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

      // Case 1: Verified swap selling old token for USDC quote token
      const sellQuoteTx: EnhancedTransaction = {
        signature: 'tx_sell_for_usdc_345',
        type: 'SWAP',
        events: { swap: {} },
        tokenTransfers: [
          { mint: oldHeldToken, tokenAmount: 5000, fromUserAccount: wallet },
          { mint: usdc, tokenAmount: 250, toUserAccount: wallet },
        ],
      };

      const movesQuote = classifyMovements(sellQuoteTx, wallet);
      assert.equal(movesQuote.length, 1);
      assert.equal(movesQuote[0].mint, oldHeldToken);
      assert.equal(movesQuote[0].amount, 5000);
      assert.equal(movesQuote[0].action, 'SELL');

      // Case 2: Verified swap selling old token for native SOL
      const sellNativeTx: EnhancedTransaction = {
        signature: 'tx_sell_for_native_678',
        type: 'SWAP',
        events: { swap: {} },
        tokenTransfers: [{ mint: oldHeldToken, tokenAmount: 2000, fromUserAccount: wallet }],
        nativeTransfers: [{ amount: 1500000000, toUserAccount: wallet }],
      };

      const movesNative = classifyMovements(sellNativeTx, wallet);
      assert.equal(movesNative.length, 1);
      assert.equal(movesNative[0].mint, oldHeldToken);
      assert.equal(movesNative[0].amount, 2000);
      assert.equal(movesNative[0].action, 'SELL');
    });
  });

  describe('Hourly Technical Signals & Indicator Baseline', () => {
    test('RSI uses hourly completed candles only and volume compares baseline', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const currentHourStart = Math.floor(nowSec / 3600) * 3600;

      // Candle structure: [timestamp_seconds, open, high, low, close, volume]
      // 1 In-progress candle (current hour, not completed yet) with massive volume anomaly
      const inProgressCandle = [currentHourStart, 100, 110, 95, 105, 9999999];

      // 1 Latest completed candle (1 hour ago) with volume = 350
      const latestCompletedCandle = [currentHourStart - 3600, 100, 108, 98, 104, 350];

      // 20 Historical completed candles (hours -2 to -21) each with baseline volume = 100
      const baselineCandles: number[][] = [];
      for (let i = 2; i <= 21; i++) {
        baselineCandles.push([currentHourStart - i * 3600, 100, 105, 95, 100 + (i % 4), 100]);
      }

      const allCandles = [inProgressCandle, latestCompletedCandle, ...baselineCandles];

      // 1. Verify in-progress candle is excluded and completed candles are used
      const signal = hourlySignal(allCandles);
      assert.notEqual(signal.latestVolume, 9999999, 'In-progress hourly candle must be excluded');
      assert.equal(signal.latestVolume, 350, 'Latest completed hourly candle volume must be used');
      assert.equal(signal.baseline, 100, 'Baseline must equal the average of the 20 completed candles prior to latest');
      assert.equal(signal.surge, true, 'Surge must be true when latest volume (350) >= 3x baseline (100 * 3 = 300)');
      assert.ok(typeof signal.rsi === 'number' && Number.isFinite(signal.rsi), 'RSI must be calculated from completed closes');

      // 2. Volume below 3x baseline does not trigger surge
      const nonSurgeLatest = [currentHourStart - 3600, 100, 108, 98, 104, 290];
      const nonSurgeSignal = hourlySignal([inProgressCandle, nonSurgeLatest, ...baselineCandles]);
      assert.equal(nonSurgeSignal.surge, false, 'Volume below 3x baseline must not trigger surge');

      // 3. Absolute large volume without baseline surge does not trigger surge
      const largeBaselineCandles: number[][] = [];
      for (let i = 2; i <= 21; i++) {
        largeBaselineCandles.push([currentHourStart - i * 3600, 100, 105, 95, 100, 2000000]);
      }
      const largeVolLatest = [currentHourStart - 3600, 100, 108, 98, 104, 5000000];
      const largeVolSignal = hourlySignal([largeVolLatest, ...largeBaselineCandles]);
      assert.equal(largeVolSignal.baseline, 2000000);
      assert.equal(largeVolSignal.surge, false, 'Large absolute volume (5M) < 3x baseline (6M) must not trigger surge');

      // 4. RSI requires at least 15 completed candle closes
      const insufficientCandles = baselineCandles.slice(0, 13); // 13 candles total
      const shortSignal = hourlySignal(insufficientCandles);
      assert.equal(shortSignal.rsi, null, 'Fewer than 15 closes must yield null RSI');

      // 5. Malformed or non-finite candles are filtered out safely
      const malformedCandles = [
        [currentHourStart - 7200, 100, Number.NaN, 95, 100, 100],
        [currentHourStart - 10800, 100, 105], // fewer than 6 elements
        ...baselineCandles.slice(0, 16),
      ];
      const cleanSignal = hourlySignal(malformedCandles);
      assert.ok(typeof cleanSignal.rsi === 'number');
    });
  });

  describe('Durable Queue & Telegram Error Resilience', () => {
    test('runOneJob Telegram 429 retries without marking done', async () => {
      await withTestContext(
        {
          env: {
            TELEGRAM_BOT_TOKEN: 'mock_token_429_test',
          },
        },
        async () => {
          const store = new FakeBotStore();
          const jobPayload = { chatId: '-2001', html: '<b>Whale Alert Test</b>' };
          await store.enqueue('send:whale_alert_429', 'send', jobPayload);

          // Mock Telegram API responding with HTTP 429 and retry_after: 45
          globalThis.fetch = async input => {
            const url = String(input);
            if (url.includes('/sendMessage')) {
              return Response.json(
                {
                  ok: false,
                  error_code: 429,
                  description: 'Too Many Requests',
                  parameters: { retry_after: 45 },
                },
                { status: 429 }
              );
            }
            return Response.json({ ok: true, result: true });
          };

          // Suppress intentional error logging during 429 backoff test
          const originalConsoleError = console.error;
          console.error = () => {};

          try {
            const executed = await runOneJob(store);

            assert.equal(executed, true, 'Job must be claimed and handled');
            assert.equal(store.finishedJobs.length, 0, '429 rate limited job must NEVER be marked done');

            assert.equal(store.retriedJobs.length, 1, 'Job must be scheduled for retry');
            assert.equal(store.retriedJobs[0].job.id, 'send:whale_alert_429');
            assert.equal(store.retriedJobs[0].delaySeconds, 45, 'Telegram retry_after duration must be passed to retry');

            const storedJob = store.jobs.get('send:whale_alert_429');
            assert.ok(storedJob);
            assert.equal(storedJob.status, 'pending', 'Job status must remain pending');
            assert.equal(storedJob.attempts, 1, 'Job attempts counter must increment');
            assert.ok(storedJob.runAfter >= Date.now() + 40000, 'Job runAfter must be postponed by at least retry_after');
          } finally {
            console.error = originalConsoleError;
          }
        }
      );
    });

    test('maintenance limits batches and yields to other queued work', async () => {
      const store = new FakeBotStore();
      store.cleanupResult = { deletedJobs: 2500, compactedJobs: 2500, deletedConfirmations: 0 };
      await store.enqueue('maintenance:2026-01-01', 'maintenance', {});
      await store.enqueue('maintenance:2026-01-02', 'maintenance', {});
      assert.equal(await runOneJob(store), true);
      assert.equal(store.cleanupCalls, 10);
      assert.equal(store.jobs.get('maintenance:2026-01-01')?.status, 'done');
      store.cleanupResult = { deletedJobs: 0, compactedJobs: 0, deletedConfirmations: 0 };
      assert.equal(await runOneJob(store), true);
      assert.equal(store.cleanupCalls, 11);
      assert.equal(store.jobs.get('maintenance:2026-01-02')?.status, 'done');
    });
    test('maintenance continues for full confirmation batches and stops on lease loss', async () => {
      const store = new FakeBotStore();
      await store.enqueue('maintenance:2026-01-03', 'maintenance', {});
      store.cleanup = async () => {
        store.cleanupCalls++;
        if (store.cleanupCalls === 1) return { deletedJobs: 0, compactedJobs: 0, deletedConfirmations: 5000 };
        store.simulateLeaseLoss = true;
        return { deletedJobs: 0, compactedJobs: 0, deletedConfirmations: 5000 };
      };
      const originalConsoleError = console.error;
      console.error = () => {};
      try {
        assert.equal(await runOneJob(store), true);
      } finally {
        console.error = originalConsoleError;
      }
      assert.equal(store.cleanupCalls, 2);
      assert.equal(store.finishedJobs.length, 0);
    });


    test('real store rejects malformed cleanup responses and retries the job', async () => {
      const invalid = [false, null, [], {}, { deletedJobs: -1, compactedJobs: 0, deletedConfirmations: 0 },
        { deletedJobs: Number.MAX_SAFE_INTEGER + 1, compactedJobs: 0, deletedConfirmations: 0 },
        { deletedJobs: 0, compactedJobs: '0', deletedConfirmations: 0 }];
      for (const response of invalid) {
        const patches: Record<string, unknown>[] = [];
        const calls: string[] = [];
        await withTestContext({
          env: { SUPABASE_URL: 'http://127.0.0.1:1234', SUPABASE_KEY: 'synthetic-test-key' },
          fetchHandler: async (input, init) => {
            const url = String(input);
            if (url.includes('bot_claim_job')) return Response.json([{ id: 'maintenance:2026-01-01', kind: 'maintenance', payload: {}, attempts: 1 }]);
            if (url.includes('bot_has_lease')) { calls.push('lease'); return Response.json(true); }
            if (url.includes('bot_cleanup_retention')) { calls.push('cleanup'); return Response.json(response); }
            if (url.includes('bot_jobs') && init?.method === 'PATCH') {
              patches.push(JSON.parse(String(init.body)));
              return Response.json([]);
            }
            throw new Error(`Unexpected fixture request: ${url}`);
          },
        }, async () => {
          const originalConsoleError = console.error;
          console.error = () => {};
          try {
            assert.equal(await runOneJob(createBotStore()), true);
          } finally {
            console.error = originalConsoleError;
          }
        });
        assert.deepEqual(patches.map(patch => patch.status), ['pending']);
        assert.ok(calls.indexOf('cleanup') > 0 && calls[calls.indexOf('cleanup') - 1] === 'lease');
      }
    });


    test('runOneJob aborts on lease loss and does not mark job done', async () => {
      const store = new FakeBotStore();
      await store.enqueue('send:lease_loss_test', 'send', { chatId: '-2001', html: 'Lease test' });

      // Simulate lease lost before job execution completes
      store.simulateLeaseLoss = true;

      const originalConsoleError = console.error;
      console.error = () => {};

      try {
        const handled = await runOneJob(store);
        assert.equal(handled, true);
        assert.equal(store.finishedJobs.length, 0, 'Job with lost lease must not be finished');
      } finally {
        console.error = originalConsoleError;
      }
    });
  });
});
