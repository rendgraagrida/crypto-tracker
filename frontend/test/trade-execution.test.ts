import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, unlink, chmod, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Wallet, Transaction, Interface, keccak256, parseUnits, toBeHex } from 'ethers';
import { PublicKey, Keypair, VersionedTransaction, TransactionMessage, SystemProgram } from '@solana/web3.js';
import { readTradePolicy, usdUnits, positiveUsd, valueUsd, checkSpotDeviation } from '../app/lib/trade-policy.ts';
import type { TradePolicy } from '../app/lib/trade-policy.ts';
import {
  prepareTrade,
  runTradeOnce,
  reconcileSigned,
  validateSolanaSwapIntent,
  type RpcCall,
} from '../app/lib/trade-signer.ts';
import type { ExecutionOrder, TradeStore, RiskLimits } from '../app/lib/trade-store.ts';
import type { SwapQuote, TradeOrder, EvmBuild } from '../app/lib/trade-types.ts';
import {
  ALLOWANCE_HOLDER,
  EVM_NATIVE,
  WSOL,
  validateEvmSwapIntent,
  parseSwapQuote,
} from '../app/lib/swap-quotes.ts';

const HOLDER_ABI = new Interface([
  'function exec(address operator,address token,uint256 amount,address target,bytes data)',
]);
const SETTLER_ABI = new Interface([
  'function execute((address recipient,address buyToken,uint256 minAmountOut),bytes[],bytes32)',
]);
const ERC20_ABI = new Interface([
  'function decimals() view returns(uint8)',
  'function allowance(address,address) view returns(uint256)',
  'function owner() view returns(address)',
]);

const TEST_SETTLER = '0x4444444444444444444444444444444444444444';
const SETTLER_CODE = '0x6001600155';
const SETTLER_CODE_HASH = keccak256(SETTLER_CODE).toLowerCase();
const HOLDER_CODE = '0x6002600255';
const HOLDER_CODE_HASH = keccak256(HOLDER_CODE).toLowerCase();
const DUMMY_ASSET = '0x3333333333333333333333333333333333333333';
const DUMMY_ASSET_CODE = '0x6003600355';
const DUMMY_ASSET_CODE_HASH = keccak256(DUMMY_ASSET_CODE).toLowerCase();

function quoteTimes(expired = false) {
  const created = Date.now() - (expired ? 35000 : 5000);
  return { createdAt: new Date(created).toISOString(), expiresAt: new Date(created + 30000).toISOString() };
}

function makeEvmCalldata(
  operator: string,
  sellToken: string,
  sellAmount: bigint,
  recipient: string,
  buyToken: string,
  minAmountOut: bigint
): string {
  const innerData = SETTLER_ABI.encodeFunctionData('execute', [
    [recipient, buyToken, minAmountOut],
    [],
    '0x' + '00'.repeat(32),
  ]);
  return HOLDER_ABI.encodeFunctionData('exec', [
    operator,
    sellToken,
    sellAmount,
    operator,
    innerData,
  ]);
}

function makeRpc(handlers: Record<string, unknown | ((params: unknown[]) => unknown)>): RpcCall {
  return async (_chain: string, method: string, params: unknown[]) => {
    if (!(method in handlers)) {
      throw new Error(`Unexpected RPC call: ${method} with params: ${JSON.stringify(params)}`);
    }
    const h = handlers[method];
    return typeof h === 'function' ? (h as (p: unknown[]) => unknown)(params) : h;
  };
}

async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const original: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    original[k] = process.env[k];
    const v = overrides[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withSyntheticFetch(
  handlers: Record<string, (url: URL, init?: RequestInit) => Response | Promise<Response>>,
  testFn: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (urlStr.includes(prefix)) {
        return handler(url, init);
      }
    }
    throw new Error('fetch not expected MUST throw before network: ' + urlStr);
  };
  try {
    await testFn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function createMemoryTradeStore(initial?: Partial<ExecutionOrder>): {
  store: TradeStore;
  orders: Map<string, ExecutionOrder>;
  riskState: { killed: boolean; reason: string | null; usedUsd: string };
  callLog: string[];
} {
  const orders = new Map<string, ExecutionOrder>();
  const callLog: string[] = [];
  const riskState = { killed: false, reason: null as string | null, usedUsd: '0' };

  if (initial && initial.id) {
    orders.set(initial.id, {
      id: initial.id,
      actor: initial.actor ?? { userId: '1001', chatId: '-2001' },
      quote: initial.quote!,
      mode: initial.mode ?? 'manual',
      notionalUsd: initial.notionalUsd ?? '100',
      status: initial.status ?? 'confirmed',
      confirmedUpdateId: initial.confirmedUpdateId ?? 1,
      txHash: initial.txHash ?? null,
      signedPayload: initial.signedPayload ?? null,
      error: initial.error ?? null,
      executionToken: initial.executionToken ?? '00000000-0000-0000-0000-000000000001',
      quoteHash: initial.quoteHash ?? '0'.repeat(64),
      riskReservedUsd: initial.riskReservedUsd ?? '0',
    });
  }

  const store: TradeStore = {
    async create(order, _fence) {
      callLog.push(`create:${order.id}`);
      orders.set(order.id, {
        ...order,
        executionToken: 'token_' + order.id,
        quoteHash: 'hash_' + order.id,
        riskReservedUsd: '0',
      });
    },
    async get(id, actor) {
      callLog.push(`get:${id}`);
      const o = orders.get(id);
      if (!o || o.actor.userId !== actor.userId || o.actor.chatId !== actor.chatId) return null;
      return o;
    },
    async list(actor) {
      callLog.push(`list:${actor.userId}`);
      return [...orders.values()].filter(o => o.actor.userId === actor.userId && o.actor.chatId === actor.chatId);
    },
    async confirm(id, actor, updateId, _fence) {
      callLog.push(`confirm:${id}`);
      const o = orders.get(id);
      if (!o || o.actor.userId !== actor.userId || o.actor.chatId !== actor.chatId) return false;
      if (o.confirmedUpdateId === updateId) return true;
      if (o.status !== 'quoted' || o.confirmedUpdateId !== null || Date.parse(o.quote.expiresAt) <= Date.now()) return false;
      o.status = 'confirmed';
      o.confirmedUpdateId = updateId;
      return true;
    },
    async setKill(killed, reason, _fence) {
      callLog.push(`setKill:${killed}`);
      riskState.killed = killed;
      riskState.reason = reason;
    },
    async risk() {
      callLog.push('risk');
      return { killed: riskState.killed, reason: riskState.reason, usedUsd: riskState.usedUsd };
    },
    async claim(signedOnly = false) {
      callLog.push(`claim:${signedOnly}`);
      for (const o of orders.values()) {
        if (signedOnly && !o.signedPayload) continue;
        if (['confirmed', 'executing', 'signed', 'submitted', 'unknown'].includes(o.status)) {
          o.status = o.status === 'confirmed' ? 'executing' : o.status;
          return { ...o };
        }
      }
      return null;
    },
    async reserve(order, costUsd, limits) {
      callLog.push(`reserve:${order.id}:${costUsd}`);
      if (riskState.killed) return false;
      const cost = usdUnits(costUsd);
      if (cost <= 0n || cost > usdUnits(limits.maxTradeUsd)) return false;
      const current = usdUnits(riskState.usedUsd);
      if (current + cost > usdUnits(limits.maxDailyLossUsd) || current + cost > usdUnits(limits.maxExposureUsd)) {
        riskState.killed = true;
        riskState.reason = 'Conservative loss/exposure budget exhausted';
        return false;
      }
      riskState.usedUsd = (Number(riskState.usedUsd) + Number(costUsd)).toFixed(6);
      const target = orders.get(order.id);
      if (target) target.riskReservedUsd = costUsd;
      return true;
    },
    async writeSigned(order, payload, hash) {
      callLog.push(`writeSigned:${order.id}:${hash}`);
      const target = orders.get(order.id);
      if (!target) throw new Error('Order missing for writeSigned');
      target.signedPayload = payload;
      target.txHash = hash;
      target.status = 'signed';
    },
    async transition(order, status, error) {
      callLog.push(`transition:${order.id}:${status}`);
      const target = orders.get(order.id);
      if (!target) throw new Error('Order missing for transition');
      target.status = status;
      target.error = error;
    },
  };

  return { store, orders, riskState, callLog };
}

describe('TradePolicy Configuration & Risk Caps', () => {
  test('readTradePolicy fails closed when live trading is disabled without reconcileOnly', async () => {
    await withEnv({ TRADE_LIVE_ENABLED: 'false' }, async () => {
      assert.throws(() => readTradePolicy(), /Live trading is disabled; no key is loaded/);
    });
  });

  test('readTradePolicy succeeds with reconcileOnly: true even when TRADE_LIVE_ENABLED is false', async () => {
    await withEnv(
      {
        TRADE_LIVE_ENABLED: 'false',
        TRADE_RISK_MODEL: 'conservative-capital-at-risk',
        TRADE_ALLOWED_CHAINS: 'ethereum,solana',
        MAX_TRADE_USD: '500',
        MAX_DAILY_LOSS_USD: '2000',
        MAX_EXPOSURE_USD: '5000',
        MAX_SLIPPAGE_BPS: '100',
        MAX_SPOT_DEVIATION_BPS: '200',
        MAX_FEE_NATIVE_RAW: '1000000000000000',
        TRADE_EVM_FINALITY_BLOCKS: '2',
        TRADE_EVM_CODE_HASHES: '{}',
      },
      async () => {
        const policy = readTradePolicy({ reconcileOnly: true });
        assert.equal(policy.live, false, 'Policy must flag live as false under reconcileOnly');
        assert.equal(policy.allowedChains.includes('ethereum'), true);
        assert.equal(policy.maxTradeUsd, '500');
      }
    );
  });

  test('readTradePolicy enforces conservative-capital-at-risk risk model', async () => {
    await withEnv(
      {
        TRADE_LIVE_ENABLED: 'true',
        TRADE_RISK_MODEL: 'optimistic-pnl',
        TRADE_ALLOWED_CHAINS: 'ethereum',
        MAX_TRADE_USD: '500',
        MAX_DAILY_LOSS_USD: '2000',
        MAX_EXPOSURE_USD: '5000',
        MAX_FEE_NATIVE_RAW: '1000000000000000',
      },
      async () => {
        assert.throws(() => readTradePolicy(), /Explicit conservative risk model approval required/);
      }
    );
  });

  test('readTradePolicy rejects inconsistent caps where maxTradeUsd exceeds loss or exposure limits', async () => {
    await withEnv(
      {
        TRADE_LIVE_ENABLED: 'true',
        TRADE_RISK_MODEL: 'conservative-capital-at-risk',
        TRADE_ALLOWED_CHAINS: 'ethereum',
        MAX_TRADE_USD: '5000',
        MAX_DAILY_LOSS_USD: '2000',
        MAX_EXPOSURE_USD: '10000',
        MAX_FEE_NATIVE_RAW: '1000000000000000',
        MAX_SLIPPAGE_BPS: '100',
        MAX_SPOT_DEVIATION_BPS: '200',
        TRADE_EVM_FINALITY_BLOCKS: '2',
      },
      async () => {
        assert.throws(() => readTradePolicy(), /Inconsistent risk limits/);
      }
    );
  });

  test('readTradePolicy enforces valid bounds for slippage (0-150) and spot deviation (0-1000)', async () => {
    await withEnv(
      {
        TRADE_LIVE_ENABLED: 'true',
        TRADE_RISK_MODEL: 'conservative-capital-at-risk',
        TRADE_ALLOWED_CHAINS: 'ethereum',
        MAX_TRADE_USD: '500',
        MAX_DAILY_LOSS_USD: '2000',
        MAX_EXPOSURE_USD: '5000',
        MAX_FEE_NATIVE_RAW: '1000000000000000',
        MAX_SLIPPAGE_BPS: '151',
        MAX_SPOT_DEVIATION_BPS: '200',
        TRADE_EVM_FINALITY_BLOCKS: '2',
      },
      async () => {
        assert.throws(() => readTradePolicy(), /Invalid MAX_SLIPPAGE_BPS/);
      }
    );

    await withEnv(
      {
        TRADE_LIVE_ENABLED: 'true',
        TRADE_RISK_MODEL: 'conservative-capital-at-risk',
        TRADE_ALLOWED_CHAINS: 'ethereum',
        MAX_TRADE_USD: '500',
        MAX_DAILY_LOSS_USD: '2000',
        MAX_EXPOSURE_USD: '5000',
        MAX_FEE_NATIVE_RAW: '1000000000000000',
        MAX_SLIPPAGE_BPS: '100',
        MAX_SPOT_DEVIATION_BPS: '1001',
        TRADE_EVM_FINALITY_BLOCKS: '2',
      },
      async () => {
        assert.throws(() => readTradePolicy(), /Invalid MAX_SPOT_DEVIATION_BPS/);
      }
    );
  });

  test('readTradePolicy validates EVM contract pin addresses and 24h asset review pins', async () => {
    await withEnv(
      {
        TRADE_LIVE_ENABLED: 'true',
        TRADE_RISK_MODEL: 'conservative-capital-at-risk',
        TRADE_ALLOWED_CHAINS: 'ethereum',
        MAX_TRADE_USD: '500',
        MAX_DAILY_LOSS_USD: '2000',
        MAX_EXPOSURE_USD: '5000',
        MAX_FEE_NATIVE_RAW: '1000000000000000',
        MAX_SLIPPAGE_BPS: '100',
        MAX_SPOT_DEVIATION_BPS: '200',
        TRADE_EVM_FINALITY_BLOCKS: '2',
        TRADE_EVM_CODE_HASHES: '{"0xnotanaddress": "0x123"}',
      },
      async () => {
        assert.throws(() => readTradePolicy(), /Invalid trusted contract pin/);
      }
    );

    const now = Date.now();
    await withEnv(
      {
        TRADE_LIVE_ENABLED: 'true',
        TRADE_RISK_MODEL: 'conservative-capital-at-risk',
        TRADE_ALLOWED_CHAINS: 'ethereum',
        MAX_TRADE_USD: '500',
        MAX_DAILY_LOSS_USD: '2000',
        MAX_EXPOSURE_USD: '5000',
        MAX_FEE_NATIVE_RAW: '1000000000000000',
        MAX_SLIPPAGE_BPS: '100',
        MAX_SPOT_DEVIATION_BPS: '200',
        TRADE_EVM_FINALITY_BLOCKS: '2',
        TRADE_EVM_CODE_HASHES: '{}',
        TRADE_EVM_ASSET_REVIEWS: JSON.stringify({
          'ethereum:0x3333333333333333333333333333333333333333': {
            codeHash: '0x' + '11'.repeat(32),
            reviewedAt: new Date(now - 1000).toISOString(),
            expiresAt: new Date(now + 90000000).toISOString(),
          },
        }),
      },
      async () => {
        assert.throws(() => readTradePolicy(), /validity of at most 24 hours/);
      }
    );
  });

  test('usdUnits and positiveUsd enforce 6-decimal notation and strictly positive amounts', () => {
    assert.equal(usdUnits('100.5'), 100500000n);
    assert.equal(usdUnits('0.000001'), 1n);
    assert.throws(() => usdUnits('0.0000001'), /at most 6 decimals/);
    assert.throws(() => usdUnits('-10'), /positive decimal notation/);
    assert.throws(() => positiveUsd('0'), /must be positive/);
    assert.equal(positiveUsd('500.00'), '500.00');
  });

  test('valueUsd enforces conservative ceiling round-up and fails on invalid parameters', () => {
    const val = valueUsd(1000000000000000000n, 18, 2500.123456);
    assert.equal(val, '2500.123456');

    const roundedUp = valueUsd(1n, 18, 1);
    assert.equal(roundedUp, '0.000001', 'Any nonzero fraction must round up to at least 1 micro-USD');

    assert.throws(() => valueUsd(-1n, 18, 100), /Invalid raw amount/);
    assert.throws(() => valueUsd(100n, 256, 100), /Unknown valuation/);
    assert.throws(() => valueUsd(100n, 18, -10), /Unknown valuation/);
  });

  test('checkSpotDeviation rejects output falling below maxDeviationBps threshold', () => {
    assert.doesNotThrow(() => checkSpotDeviation('100.00', '98.50', 200));
    assert.throws(() => checkSpotDeviation('100.00', '97.00', 200), /Minimum received fails conservative spot valuation limit/);
  });
});

describe('prepareTrade Security Evidence & Validation Gates', () => {
  const OWNER_USER = '1001';
  const OWNER_CHAT = '-2001';

  function validPolicy(overrides: Partial<TradePolicy> = {}): TradePolicy {
    return {
      live: true,
      auto: false,
      allowedChains: ['ethereum', 'solana'],
      maxTradeUsd: '1000',
      maxDailyLossUsd: '3000',
      maxExposureUsd: '5000',
      maxSlippageBps: 100,
      maxDeviationBps: 200,
      maxFeeNativeRaw: 1000000000000000n,
      maxRentLamports: 2000000n,
      tipLamports: 10000n,
      jitoTipAccount: '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
      finalityBlocks: 2,
      settlerCodeHashes: {
        [ALLOWANCE_HOLDER.toLowerCase()]: HOLDER_CODE_HASH,
        [TEST_SETTLER.toLowerCase()]: SETTLER_CODE_HASH,
      },
      solanaProgramDataHash: '0'.repeat(64),
      assetReviews: {
        [`ethereum:${DUMMY_ASSET.toLowerCase()}`]: {
          codeHash: DUMMY_ASSET_CODE_HASH,
          reviewedAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      },
      ...overrides,
    };
  }

  function validEvmQuote(taker: string, overrides: Partial<SwapQuote> = {}): SwapQuote & { build: EvmBuild } {
    const amountRaw = '100000000000000000'; // 0.1 ETH
    const calldata = makeEvmCalldata(
      TEST_SETTLER,
      EVM_NATIVE,
      BigInt(amountRaw),
      taker,
      DUMMY_ASSET,
      990000000000000000n
    );
    const quote = parseSwapQuote({
      chain: 'ethereum',
      inputToken: EVM_NATIVE,
      outputToken: DUMMY_ASSET,
      amountRaw,
      amountOutRaw: '1000000000000000000',
      minOutRaw: '990000000000000000',
      taker,
      slippageBps: 100,
      priceImpactBps: 10,
      feeNativeRaw: '50000000000000', // 50000 * 1 gwei
      feesDescription: 'Synthetic gas',
      provider: '0x-v2',
      ...quoteTimes(),
      build: {
        kind: 'evm',
        chainId: 1,
        to: ALLOWANCE_HOLDER,
        data: calldata,
        value: amountRaw,
        gas: '50000',
        gasPrice: '1000000000',
        allowance: null,
      },
      ...overrides,
    });
    if (quote.build.kind !== 'evm') throw new Error('Invalid EVM fixture');
    return { ...quote, build: quote.build };
  }

  function validOrder(quote: SwapQuote): ExecutionOrder {
    return {
      id: 'ord_test_001',
      actor: { userId: OWNER_USER, chatId: OWNER_CHAT },
      quote,
      mode: 'manual',
      notionalUsd: '300.00',
      status: 'confirmed',
      confirmedUpdateId: 99,
      txHash: null,
      signedPayload: null,
      error: null,
      executionToken: 'token_001',
      quoteHash: 'hash_001',
      riskReservedUsd: '0',
    };
  }

  test('prepareTrade throws when quote is stale or expired', async () => {
    const wallet = Wallet.createRandom();
    const taker = wallet.address.toLowerCase();
    const expiredQuote = validEvmQuote(taker, {
      ...quoteTimes(true),
    });
    const order = validOrder(expiredQuote);
    const policy = validPolicy();

    await withEnv(
      {
        TRADE_EVM_TAKER: taker,
        TELEGRAM_ALLOWED_USER_IDS: OWNER_USER,
        TELEGRAM_ALLOWED_CHAT_IDS: OWNER_CHAT,
      },
      async () => {
        await assert.rejects(
          prepareTrade(order, policy, makeRpc({})),
          /Trade permission\/expiry check failed/
        );
      }
    );
  });

  test('prepareTrade throws when actor authorization is revoked', async () => {
    const wallet = Wallet.createRandom();
    const taker = wallet.address.toLowerCase();
    const quote = validEvmQuote(taker);
    const order = validOrder(quote);
    const policy = validPolicy();

    await withEnv(
      {
        TRADE_EVM_TAKER: taker,
        TELEGRAM_ALLOWED_USER_IDS: '9999',
        TELEGRAM_ALLOWED_CHAT_IDS: OWNER_CHAT,
      },
      async () => {
        await assert.rejects(
          prepareTrade(order, policy, makeRpc({})),
          /Trading actor\/chat authorization revoked/
        );
      }
    );
  });

  test('prepareTrade blocks live signing on L2 chains (base, optimism, arbitrum)', async () => {
    const taker = Wallet.createRandom().address.toLowerCase();
    const quote = validEvmQuote(taker);
    await withEnv({
      TRADE_EVM_TAKER: taker,
      TELEGRAM_ALLOWED_USER_IDS: OWNER_USER,
      TELEGRAM_ALLOWED_CHAT_IDS: OWNER_CHAT,
    }, async () => {
      for (const [chain, chainId] of [['base', 8453], ['optimism', 10], ['arbitrum', 42161]] as const) {
        const l2Quote = { ...quote, chain, build: { ...quote.build, chainId } };
        const order = validOrder(l2Quote), policy = validPolicy({ allowedChains: [chain] });
        await assert.rejects(prepareTrade(order, policy, makeRpc({})), Error);
      }
    });
  });

  test('prepareTrade blocks execution when dedicated taker does not match', async () => {
    const wallet = Wallet.createRandom();
    const taker = wallet.address.toLowerCase();
    const quote = validEvmQuote(taker);
    const order = validOrder(quote);
    const policy = validPolicy();

    await withEnv(
      {
        TRADE_EVM_TAKER: '0x9999999999999999999999999999999999999999',
        TELEGRAM_ALLOWED_USER_IDS: OWNER_USER,
        TELEGRAM_ALLOWED_CHAT_IDS: OWNER_CHAT,
      },
      async () => {
        await assert.rejects(
          prepareTrade(order, policy, makeRpc({})),
          /Dedicated taker mismatch/
        );
      }
    );
  });

  test('calldata mismatched recipient is rejected by validateEvmSwapIntent', () => {
    const wallet = Wallet.createRandom();
    const taker = wallet.address.toLowerCase();
    const badCalldata = makeEvmCalldata(
      TEST_SETTLER,
      EVM_NATIVE,
      100000000000000000n,
      '0x000000000000000000000000000000000000dead', // Mismatched recipient
      DUMMY_ASSET,
      990000000000000000n
    );
    const quote = validEvmQuote(taker);
    quote.build.data = badCalldata;

    assert.throws(
      () => validateEvmSwapIntent(quote, [TEST_SETTLER]),
      Error
    );
  });

  test('reviewed Solana route rejects a substituted output ATA', () => {
    const taker = Keypair.generate().publicKey.toBase58(), outputToken = Keypair.generate().publicKey.toBase58();
    const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const associated = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const derive = (mint: string) => PublicKey.findProgramAddressSync([new PublicKey(taker).toBuffer(), tokenProgram.toBuffer(), new PublicKey(mint).toBuffer()], associated)[0].toBase58();
    const data = Buffer.alloc(35);
    createHash('sha256').update('global:route').digest().copy(data, 0, 0, 8);
    data.writeUInt32LE(1, 8); data[12] = 7; data[13] = 100; data[14] = 0; data[15] = 1;
    data.writeBigUInt64LE(1000000n, 16); data.writeBigUInt64LE(500000n, 24); data.writeUInt16LE(100, 32); data[34] = 0;
    const jupiter = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
    const quote = parseSwapQuote({
      chain:'solana',inputToken:WSOL,outputToken,amountRaw:'1000000',amountOutRaw:'500000',minOutRaw:'495000',taker,slippageBps:100,
      priceImpactBps:null,feeNativeRaw:null,feesDescription:'Unknown fee; synthetic intent only',provider:'jupiter-v2',
      createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+25000).toISOString(),
      build:{kind:'solana',computeBudgetInstructions:[],setupInstructions:[],cleanupInstruction:null,otherInstructions:[],addressesByLookupTableAddress:{},
        blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:12345,
        swapInstruction:{programId:jupiter,data:data.toString('base64'),accounts:[tokenProgram.toBase58(),taker,derive(WSOL),derive(outputToken),jupiter,outputToken,jupiter].map((pubkey,i)=>({pubkey,isSigner:i===1,isWritable:i===2||i===3}))}}
    });
    validateSolanaSwapIntent(quote);
    if(quote.build.kind!=='solana')throw new Error('Invalid fixture');
    quote.build.swapInstruction.accounts[3].pubkey = Keypair.generate().publicKey.toBase58();
    assert.throws(() => validateSolanaSwapIntent(quote), Error);
  });

  test('EVM check rejects chain ID mismatch or untrusted/altered settler bytecode', async () => {
    const wallet = Wallet.createRandom();
    const taker = wallet.address.toLowerCase();
    const quote = validEvmQuote(taker);
    const order = validOrder(quote);
    const policy = validPolicy();

    const badChainRpc = makeRpc({
      eth_call: (params: unknown[]) => {
        const call = params[0] as { data: string };
        return call.data === ERC20_ABI.encodeFunctionData('owner') ? '0x' + '00'.repeat(32) : '0x12';
      },
      eth_chainId: '0x38', // BSC chainId 56 instead of 1
      eth_getCode: DUMMY_ASSET_CODE,
    });

    await withEnv(
      {
        TRADE_EVM_TAKER: taker,
        TRADE_EVM_MEV_PROTECTED: 'true',
        TELEGRAM_ALLOWED_USER_IDS: OWNER_USER,
        TELEGRAM_ALLOWED_CHAT_IDS: OWNER_CHAT,
      },
      async () => {
        await withSyntheticFetch(
          {
            dexscreener: () =>
              new Response(
                JSON.stringify([
                  {
                    chainId: 'ethereum',
                    baseToken: { address: DUMMY_ASSET, symbol: 'TEST' },
                    quoteToken: { address: EVM_NATIVE, symbol: 'ETH' },
                    priceUsd: '250.00',
                    liquidity: { usd: 500000 },
                    marketCap: 1000000,
                    pairAddress: '0xpool1',
                    updatedAt: new Date().toISOString(),
                  },
                ])
              ),
            gopluslabs: () =>
              new Response(
                JSON.stringify({
                  code: 1,
                  result: {
                    [DUMMY_ASSET.toLowerCase()]: {
                      is_open_source: '1',
                      is_honeypot: '0',
                      is_mintable: '0',
                      is_proxy: '0',
                      can_take_back_ownership: '0',
                      buy_tax: '0',
                      sell_tax: '0',
                      holder_count: '100',
                      holders: [{ address: '0x1', percent: 0.05 }],
                    },
                  },
                })
              ),
            coingecko: () =>
              new Response(JSON.stringify({ ethereum: { usd: 2500 } })),
          },
          async () => {
            await assert.rejects(
              prepareTrade(order, policy, badChainRpc),
              /RPC chain mismatch/
            );
          }
        );
      }
    );
  });

  test('EVM check rejects pending nonce mismatch (reconciliation required)', async () => {
    const wallet = Wallet.createRandom();
    const taker = wallet.address.toLowerCase();
    const quote = validEvmQuote(taker);
    const order = validOrder(quote);
    const policy = validPolicy();

    const nonceMismatchRpc = makeRpc({
      eth_call: (params: unknown[]) => {
        const p0 = (params as Record<string, unknown>[])[0];
        if (p0 && p0.data === ERC20_ABI.encodeFunctionData('owner')) {
          return '0x' + '00'.repeat(32);
        }
        return '0x0000000000000000000000000000000000000000000000000000000000000012';
      },
      eth_chainId: '0x1',
      eth_getCode: (params: unknown[]) => {
        const addr = String(params[0]).toLowerCase();
        if (addr === ALLOWANCE_HOLDER.toLowerCase()) return HOLDER_CODE;
        if (addr === TEST_SETTLER.toLowerCase()) return SETTLER_CODE;
        if (addr === DUMMY_ASSET.toLowerCase()) return DUMMY_ASSET_CODE;
        return '0x';
      },
      eth_getTransactionCount: (params: unknown[]) => {
        return params[1] === 'pending' ? '0x5' : '0x4'; // Nonce mismatch!
      },
    });

    await withEnv(
      {
        TRADE_EVM_TAKER: taker,
        TRADE_EVM_MEV_PROTECTED: 'true',
        TELEGRAM_ALLOWED_USER_IDS: OWNER_USER,
        TELEGRAM_ALLOWED_CHAT_IDS: OWNER_CHAT,
      },
      async () => {
        await withSyntheticFetch(
          {
            dexscreener: () =>
              new Response(
                JSON.stringify([
                  {
                    chainId: 'ethereum',
                    baseToken: { address: DUMMY_ASSET, symbol: 'TEST' },
                    quoteToken: { address: EVM_NATIVE, symbol: 'ETH' },
                    priceUsd: '250.00',
                    liquidity: { usd: 500000 },
                    marketCap: 1000000,
                    pairAddress: '0xpool1',
                    updatedAt: new Date().toISOString(),
                  },
                ])
              ),
            gopluslabs: () =>
              new Response(
                JSON.stringify({
                  code: 1,
                  result: {
                    [DUMMY_ASSET.toLowerCase()]: {
                      is_open_source: '1',
                      is_honeypot: '0',
                      is_mintable: '0',
                      is_proxy: '0',
                      can_take_back_ownership: '0',
                      buy_tax: '0',
                      sell_tax: '0',
                      holder_count: '100',
                      holders: [{ address: '0x1', percent: 0.05 }],
                    },
                  },
                })
              ),
            coingecko: () =>
              new Response(JSON.stringify({ ethereum: { usd: 2500 } })),
          },
          async () => {
            await assert.rejects(
              prepareTrade(order, policy, nonceMismatchRpc),
              /Pending or invalid nonce; reconcile first/
            );
          }
        );
      }
    );
  });

});

describe('Real Signature Verification & Ephemeral Keyfile Isolation', () => {
  const OWNER_USER = '1001';
  const OWNER_CHAT = '-2001';

  test('generates ephemeral Wallet, writes 0o600 keyfile outside repo, produces valid EVM signature matching taker, cleans up keyfile', async () => {
    const wallet = Wallet.createRandom();
    const taker = wallet.address.toLowerCase();
    const keyfilePath = join(tmpdir(), `test-evm-${Date.now()}-${Math.random().toString(36).slice(2)}.key`);
    await writeFile(keyfilePath, wallet.privateKey, { mode: 0o600 });

    try {
      const amountRaw = '100000000000000000'; // 0.1 ETH
      const calldata = makeEvmCalldata(
        TEST_SETTLER,
        EVM_NATIVE,
        BigInt(amountRaw),
        taker,
        DUMMY_ASSET,
        990000000000000000n
      );
      const quote = parseSwapQuote({
        chain: 'ethereum',
        inputToken: EVM_NATIVE,
        outputToken: DUMMY_ASSET,
        amountRaw,
        amountOutRaw: '1000000000000000000',
        minOutRaw: '990000000000000000',
        taker,
        slippageBps: 100,
        priceImpactBps: 10,
        feeNativeRaw: '50000000000000',
        feesDescription: 'Synthetic gas',
        provider: '0x-v2',
        ...quoteTimes(),
        build: {
          kind: 'evm',
          chainId: 1,
          to: ALLOWANCE_HOLDER,
          data: calldata,
          value: amountRaw,
          gas: '50000',
          gasPrice: '1000000000',
          allowance: null,
        },
      });

      const order: ExecutionOrder = {
        id: 'ord_real_sig_001',
        actor: { userId: OWNER_USER, chatId: OWNER_CHAT },
        quote,
        mode: 'manual',
        notionalUsd: '300.00',
        status: 'confirmed',
        confirmedUpdateId: 1,
        txHash: null,
        signedPayload: null,
        error: null,
        executionToken: 'token_sig_001',
        quoteHash: 'hash_sig_001',
        riskReservedUsd: '0',
      };

      const policy: TradePolicy = {
        live: true,
        auto: false,
        allowedChains: ['ethereum'],
        maxTradeUsd: '1000',
        maxDailyLossUsd: '3000',
        maxExposureUsd: '5000',
        maxSlippageBps: 100,
        maxDeviationBps: 200,
        maxFeeNativeRaw: 1000000000000000n,
        maxRentLamports: 0n,
        tipLamports: 0n,
        jitoTipAccount: '',
        finalityBlocks: 2,
        settlerCodeHashes: {
          [ALLOWANCE_HOLDER.toLowerCase()]: HOLDER_CODE_HASH,
          [TEST_SETTLER.toLowerCase()]: SETTLER_CODE_HASH,
        },
        solanaProgramDataHash: '',
        assetReviews: {
          [`ethereum:${DUMMY_ASSET.toLowerCase()}`]: {
            codeHash: DUMMY_ASSET_CODE_HASH,
            reviewedAt: new Date(Date.now() - 1000).toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        },
      };

      const rpc = makeRpc({
        eth_call: (params: unknown[]) => {
          const p0 = (params as Record<string, unknown>[])[0];
          if (p0 && p0.data === ERC20_ABI.encodeFunctionData('owner')) {
            return '0x' + '00'.repeat(32); // Renounced owner
          }
          if (p0 && p0.data === ERC20_ABI.encodeFunctionData('decimals')) {
            return '0x0000000000000000000000000000000000000000000000000000000000000012'; // 18 decimals
          }
          return '0x';
        },
        eth_chainId: '0x1',
        eth_getCode: (params: unknown[]) => {
          const addr = String(params[0]).toLowerCase();
          if (addr === ALLOWANCE_HOLDER.toLowerCase()) return HOLDER_CODE;
          if (addr === TEST_SETTLER.toLowerCase()) return SETTLER_CODE;
          if (addr === DUMMY_ASSET.toLowerCase()) return DUMMY_ASSET_CODE;
          return '0x';
        },
        eth_getTransactionCount: () => '0x0',
        eth_getBalance: () => '0x1000000000000000000', // 1 ETH
      });

      await withEnv(
        {
          TRADE_EVM_KEY_FILE: keyfilePath,
          TRADE_EVM_TAKER: taker,
          TRADE_EVM_MEV_PROTECTED: 'true',
          TELEGRAM_ALLOWED_USER_IDS: OWNER_USER,
          TELEGRAM_ALLOWED_CHAT_IDS: OWNER_CHAT,
        },
        async () => {
          await withSyntheticFetch(
            {
              dexscreener: () =>
                new Response(
                  JSON.stringify([
                    {
                      chainId: 'ethereum',
                      baseToken: { address: DUMMY_ASSET, symbol: 'TEST' },
                      quoteToken: { address: EVM_NATIVE, symbol: 'ETH' },
                      priceUsd: '250.00',
                      liquidity: { usd: 500000 },
                      marketCap: 1000000,
                      pairAddress: '0xpool1',
                      updatedAt: new Date().toISOString(),
                    },
                  ])
                ),
              gopluslabs: () =>
                new Response(
                  JSON.stringify({
                    code: 1,
                    result: {
                      [DUMMY_ASSET.toLowerCase()]: {
                        is_open_source: '1',
                        is_honeypot: '0',
                        is_mintable: '0',
                        is_proxy: '0',
                        can_take_back_ownership: '0',
                        buy_tax: '0',
                        sell_tax: '0',
                        holder_count: '100',
                        holders: [{ address: '0x1', percent: 0.05 }],
                      },
                    },
                  })
                ),
              coingecko: () =>
                new Response(JSON.stringify({ ethereum: { usd: 2500 } })),
            },
            async () => {
              const plan = await prepareTrade(order, policy, rpc);
              assert.ok(plan.costUsd);
              assert.equal(typeof plan.sign, 'function');

              const signed = await plan.sign();
              assert.equal(signed.kind, 'evm');
              assert.ok(signed.raw);
              assert.ok(signed.hash);

              const parsed = Transaction.from(signed.raw);
              assert.equal(parsed.from?.toLowerCase(), taker, 'Recovered signer address must match taker');
              assert.equal(parsed.hash, signed.hash, 'Transaction hash must match reported signed hash');
              assert.equal(parsed.to?.toLowerCase(), ALLOWANCE_HOLDER.toLowerCase());
              assert.equal(parsed.value, BigInt(amountRaw));
              await writeFile(keyfilePath, 'x'.repeat(4097));
              await assert.rejects(plan.sign(), Error);
              await unlink(keyfilePath);
              await assert.rejects(plan.sign(), Error);
            }
          );
        }
      );
    } finally {
      await unlink(keyfilePath).catch(() => {});
    }
  });

});

describe('reconcileSigned On-Chain Finality & Mempool Handling', () => {
  const taker = '0x1111111111111111111111111111111111111111';
  const dummyWallet = Wallet.createRandom();

  async function createSignedEvmOrder(): Promise<{ order: ExecutionOrder; signedRaw: string; hash: string }> {
    const amountRaw = '100000000000000000';
    const calldata = makeEvmCalldata(TEST_SETTLER, EVM_NATIVE, BigInt(amountRaw), dummyWallet.address.toLowerCase(), DUMMY_ASSET, 990000000000000000n);
    const quote = parseSwapQuote({
      chain: 'ethereum',
      inputToken: EVM_NATIVE,
      outputToken: DUMMY_ASSET,
      amountRaw,
      amountOutRaw: '1000000000000000000',
      minOutRaw: '990000000000000000',
      taker: dummyWallet.address.toLowerCase(),
      slippageBps: 100,
      priceImpactBps: 10,
      feeNativeRaw: '50000000000000',
      feesDescription: 'Synthetic gas',
      provider: '0x-v2',
      ...quoteTimes(),
      build: {
        kind: 'evm',
        chainId: 1,
        to: ALLOWANCE_HOLDER,
        data: calldata,
        value: amountRaw,
        gas: '50000',
        gasPrice: '1000000000',
        allowance: null,
      },
    });

    const raw = await dummyWallet.signTransaction({
      chainId: 1,
      nonce: 0,
      to: ALLOWANCE_HOLDER,
      data: calldata,
      value: BigInt(amountRaw),
      gasLimit: 50000n,
      gasPrice: 1000000000n,
      type: 0,
    });
    const parsed = Transaction.from(raw);
    const hash = parsed.hash!;
    const payload = JSON.stringify({ raw, hash, kind: 'evm' });

    const order: ExecutionOrder = {
      id: 'ord_reconcile_001',
      actor: { userId: '1001', chatId: '-2001' },
      quote,
      mode: 'manual',
      notionalUsd: '300.00',
      status: 'signed',
      confirmedUpdateId: 1,
      txHash: hash,
      signedPayload: payload,
      error: null,
      executionToken: 'tok_001',
      quoteHash: 'qhash_001',
      riskReservedUsd: '300.00',
    };

    return { order, signedRaw: raw, hash };
  }

  const policy: TradePolicy = {
    live: true,
    auto: false,
    allowedChains: ['ethereum'],
    maxTradeUsd: '1000',
    maxDailyLossUsd: '3000',
    maxExposureUsd: '5000',
    maxSlippageBps: 100,
    maxDeviationBps: 200,
    maxFeeNativeRaw: 1000000000000000n,
    maxRentLamports: 0n,
    tipLamports: 0n,
    jitoTipAccount: '',
    finalityBlocks: 4,
    settlerCodeHashes: {},
    solanaProgramDataHash: '',
  };

  test('EVM: receipt with status 1 but confirmations < finalityBlocks returns unknown', async () => {
    const { order, hash } = await createSignedEvmOrder();
    const rpc = makeRpc({
      eth_chainId: '0x1',
      eth_getTransactionReceipt: () => ({
        transactionHash: hash,
        from: dummyWallet.address.toLowerCase(),
        blockNumber: '0x64', // 100
        blockHash: '0xblock100',
        status: '0x1',
      }),
      eth_blockNumber: () => '0x65', // 101 -> confirmations = 101 - 100 + 1 = 2 < finalityBlocks (4)
      eth_getBlockByNumber: () => ({ hash: '0xblock100' }),
    });

    const status = await reconcileSigned(order, policy, rpc);
    assert.equal(status, 'unknown', 'Insufficient block confirmations must remain unknown');
  });

  test('EVM: receipt with status 1 and confirmations >= finalityBlocks returns confirmed_onchain', async () => {
    const { order, hash } = await createSignedEvmOrder();
    const rpc = makeRpc({
      eth_chainId: '0x1',
      eth_getTransactionReceipt: () => ({
        transactionHash: hash,
        from: dummyWallet.address.toLowerCase(),
        blockNumber: '0x64', // 100
        blockHash: '0xblock100',
        status: '0x1',
      }),
      eth_blockNumber: () => '0x68', // 104 -> confirmations = 104 - 100 + 1 = 5 >= 4
      eth_getBlockByNumber: () => ({ hash: '0xblock100' }),
    });

    const status = await reconcileSigned(order, policy, rpc);
    assert.equal(status, 'confirmed_onchain', 'Finalized receipt with status 1 must return confirmed_onchain');
  });

  test('EVM: receipt with status 0 (reverted) and confirmations >= finalityBlocks returns failed', async () => {
    const { order, hash } = await createSignedEvmOrder();
    const rpc = makeRpc({
      eth_chainId: '0x1',
      eth_getTransactionReceipt: () => ({
        transactionHash: hash,
        from: dummyWallet.address.toLowerCase(),
        blockNumber: '0x64',
        blockHash: '0xblock100',
        status: '0x0', // Reverted
      }),
      eth_blockNumber: () => '0x68',
      eth_getBlockByNumber: () => ({ hash: '0xblock100' }),
    });

    const status = await reconcileSigned(order, policy, rpc);
    assert.equal(status, 'failed', 'Finalized receipt with status 0 must return failed');
  });

  test('EVM: receipt identity mismatch throws error', async () => {
    const { order, hash } = await createSignedEvmOrder();
    const rpc = makeRpc({
      eth_chainId: '0x1',
      eth_getTransactionReceipt: () => ({
        transactionHash: hash,
        from: '0x0000000000000000000000000000000000000bad',
        blockNumber: '0x64',
        blockHash: '0xblock100',
        status: '0x1',
      }),
    });

    await assert.rejects(
      reconcileSigned(order, policy, rpc),
      /Receipt identity mismatch/
    );
  });

  test('EVM: receipt null but transaction present in mempool returns submitted without re-broadcasting', async () => {
    const { order } = await createSignedEvmOrder();
    let broadcastAttempted = false;

    const rpc = makeRpc({
      eth_chainId: '0x1',
      eth_getTransactionReceipt: () => null,
      eth_getTransactionByHash: () => ({ hash: order.txHash, from: dummyWallet.address.toLowerCase() }),
      eth_sendRawTransaction: () => {
        broadcastAttempted = true;
        return order.txHash;
      },
    });

    const status = await reconcileSigned(order, policy, rpc);
    assert.equal(status, 'submitted');
    assert.equal(broadcastAttempted, false, 'Must not re-broadcast if tx is already detected in mempool');
  });

  test('EVM: receipt null and tx null broadcasts identical signed raw when live and unexpired', async () => {
    const { order, signedRaw } = await createSignedEvmOrder();
    let sentRaw = '';

    const rpc = makeRpc({
      eth_chainId: '0x1',
      eth_getTransactionReceipt: () => null,
      eth_getTransactionByHash: () => null,
      eth_sendRawTransaction: (params: unknown[]) => {
        sentRaw = String(params[0]);
        return order.txHash;
      },
    });

    await withEnv({ TRADE_EVM_MEV_PROTECTED: 'true' }, async () => {
      const status = await reconcileSigned(order, policy, rpc);
      assert.equal(status, 'submitted');
      assert.equal(sentRaw, signedRaw, 'Outbound broadcast must submit identical durable signed bytes');
    });
  });

  test('EVM: receipt null and tx null does not broadcast when expired, returns unknown', async () => {
    const { order } = await createSignedEvmOrder();
    order.quote.expiresAt = new Date(Date.now() - 5000).toISOString(); // Stale quote
    let broadcastAttempted = false;

    const rpc = makeRpc({
      eth_chainId: '0x1',
      eth_getTransactionReceipt: () => null,
      eth_getTransactionByHash: () => null,
      eth_sendRawTransaction: () => {
        broadcastAttempted = true;
        return order.txHash;
      },
    });

    await withEnv({ TRADE_EVM_MEV_PROTECTED: 'true' }, async () => {
      const status = await reconcileSigned(order, policy, rpc);
      assert.equal(status, 'unknown');
      assert.equal(broadcastAttempted, false, 'Expired quote must not be broadcast');
    });
  });
});

describe('runTradeOnce Atomic Write-Ahead & Durable Recovery', () => {
  const dummyWallet = Wallet.createRandom();

  async function createTestExecutionOrder(): Promise<{ order: ExecutionOrder; raw: string; hash: string }> {
    const amountRaw = '100000000000000000';
    const calldata = makeEvmCalldata(TEST_SETTLER, EVM_NATIVE, BigInt(amountRaw), dummyWallet.address.toLowerCase(), DUMMY_ASSET, 990000000000000000n);
    const quote = parseSwapQuote({
      chain: 'ethereum',
      inputToken: EVM_NATIVE,
      outputToken: DUMMY_ASSET,
      amountRaw,
      amountOutRaw: '1000000000000000000',
      minOutRaw: '990000000000000000',
      taker: dummyWallet.address.toLowerCase(),
      slippageBps: 100,
      priceImpactBps: 10,
      feeNativeRaw: '50000000000000',
      feesDescription: 'Synthetic gas',
      provider: '0x-v2',
      ...quoteTimes(),
      build: {
        kind: 'evm',
        chainId: 1,
        to: ALLOWANCE_HOLDER,
        data: calldata,
        value: amountRaw,
        gas: '50000',
        gasPrice: '1000000000',
        allowance: null,
      },
    });

    const raw = await dummyWallet.signTransaction({
      chainId: 1,
      nonce: 0,
      to: ALLOWANCE_HOLDER,
      data: calldata,
      value: BigInt(amountRaw),
      gasLimit: 50000n,
      gasPrice: 1000000000n,
      type: 0,
    });
    const parsed = Transaction.from(raw);
    const hash = parsed.hash!;

    const order: ExecutionOrder = {
      id: 'ord_atomic_001',
      actor: { userId: '1001', chatId: '-2001' },
      quote,
      mode: 'manual',
      notionalUsd: '300.00',
      status: 'confirmed',
      confirmedUpdateId: 1,
      txHash: null,
      signedPayload: null,
      error: null,
      executionToken: 'token_atomic_001',
      quoteHash: 'hash_atomic_001',
      riskReservedUsd: '0',
    };

    return { order, raw, hash };
  }

  const policy: TradePolicy = {
    live: true,
    auto: false,
    allowedChains: ['ethereum'],
    maxTradeUsd: '1000',
    maxDailyLossUsd: '3000',
    maxExposureUsd: '5000',
    maxSlippageBps: 100,
    maxDeviationBps: 200,
    maxFeeNativeRaw: 1000000000000000n,
    maxRentLamports: 0n,
    tipLamports: 0n,
    jitoTipAccount: '',
    finalityBlocks: 2,
    settlerCodeHashes: {
      [ALLOWANCE_HOLDER.toLowerCase()]: HOLDER_CODE_HASH,
      [TEST_SETTLER.toLowerCase()]: SETTLER_CODE_HASH,
    },
    solanaProgramDataHash: '',
    assetReviews: {
      [`ethereum:${DUMMY_ASSET.toLowerCase()}`]: {
        codeHash: DUMMY_ASSET_CODE_HASH,
        reviewedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    },
  };


  test('runTradeOnce transitions claimed order to failed if risk switch is active', async () => {
    const { order } = await createTestExecutionOrder();
    const { store, orders, riskState } = createMemoryTradeStore(order);
    riskState.killed = true;
    riskState.reason = 'Emergency kill switch';

    const result = await runTradeOnce(store, policy, makeRpc({}));
    assert.equal(result, true);
    assert.equal(orders.get(order.id)?.status, 'failed');
    assert.equal(orders.get(order.id)?.error, 'Kill switch active');
  });

  test('runTradeOnce transitions claimed order to expired if quote expires before signing', async () => {
    const { order } = await createTestExecutionOrder();
    order.quote.expiresAt = new Date(Date.now() - 1000).toISOString();
    const { store, orders } = createMemoryTradeStore(order);

    const result = await runTradeOnce(store, policy, makeRpc({}));
    assert.equal(result, true);
    assert.equal(orders.get(order.id)?.status, 'expired');
  });

  test('atomic write-ahead: writes signed payload BEFORE broadcast, lost ACK transitions to unknown', async () => {
    const { order } = await createTestExecutionOrder();
    const { store, orders, callLog } = createMemoryTradeStore(order);

    const keyfilePath = join(tmpdir(), `test-write-ahead-${Date.now()}.key`);
    await writeFile(keyfilePath, dummyWallet.privateKey, { mode: 0o600 });

    try {
      const rpc = makeRpc({
        eth_call: (params: unknown[]) => {
          const p0 = (params as Record<string, unknown>[])[0];
          if (p0 && p0.data === ERC20_ABI.encodeFunctionData('owner')) return '0x' + '00'.repeat(32);
          if (p0 && p0.data === ERC20_ABI.encodeFunctionData('decimals')) return '0x0000000000000000000000000000000000000000000000000000000000000012';
          return '0x';
        },
        eth_chainId: '0x1',
        eth_getCode: (params: unknown[]) => {
          const addr = String(params[0]).toLowerCase();
          if (addr === ALLOWANCE_HOLDER.toLowerCase()) return HOLDER_CODE;
          if (addr === TEST_SETTLER.toLowerCase()) return SETTLER_CODE;
          if (addr === DUMMY_ASSET.toLowerCase()) return DUMMY_ASSET_CODE;
          return '0x';
        },
        eth_getTransactionCount: () => '0x0',
        eth_getBalance: () => '0x1000000000000000000',
        eth_getTransactionReceipt: () => null,
        eth_getTransactionByHash: () => null,
        eth_sendRawTransaction: () => {
          // Simulate network lost ACK / RPC failure during broadcast
          throw new Error('RPC network lost ACK after durable write');
        },
      });

      await withEnv(
        {
          TRADE_EVM_KEY_FILE: keyfilePath,
          TRADE_EVM_TAKER: dummyWallet.address.toLowerCase(),
          TRADE_EVM_MEV_PROTECTED: 'true',
          TELEGRAM_ALLOWED_USER_IDS: '1001',
          TELEGRAM_ALLOWED_CHAT_IDS: '-2001',
        },
        async () => {
          await withSyntheticFetch(
            {
              dexscreener: () =>
                new Response(
                  JSON.stringify([
                    {
                      chainId: 'ethereum',
                      baseToken: { address: DUMMY_ASSET, symbol: 'TEST' },
                      quoteToken: { address: EVM_NATIVE, symbol: 'ETH' },
                      priceUsd: '250.00',
                      liquidity: { usd: 500000 },
                      marketCap: 1000000,
                      pairAddress: '0xpool1',
                      updatedAt: new Date().toISOString(),
                    },
                  ])
                ),
              gopluslabs: () =>
                new Response(
                  JSON.stringify({
                    code: 1,
                    result: {
                      [DUMMY_ASSET.toLowerCase()]: {
                        is_open_source: '1',
                        is_honeypot: '0',
                        is_mintable: '0',
                        is_proxy: '0',
                        can_take_back_ownership: '0',
                        buy_tax: '0',
                        sell_tax: '0',
                        holder_count: '100',
                        holders: [{ address: '0x1', percent: 0.05 }],
                      },
                    },
                  })
                ),
              coingecko: () =>
                new Response(JSON.stringify({ ethereum: { usd: 2500 } })),
            },
            async () => {
              const ran = await runTradeOnce(store, policy, rpc);
              assert.equal(ran, true);

              // Verify call order: writeSigned was called BEFORE transition
              const writeIndex = callLog.findIndex(c => c.startsWith('writeSigned:'));
              const transIndex = callLog.findIndex(c => c.startsWith('transition:'));
              assert.ok(writeIndex >= 0, 'writeSigned must be executed');
              assert.ok(transIndex > writeIndex, 'transition must occur after writeSigned');

              const stored = orders.get(order.id);
              assert.ok(stored?.signedPayload, 'Signed payload must be preserved in storage');
              assert.ok(stored?.txHash, 'Transaction hash must be preserved in storage');
              assert.equal(stored?.status, 'unknown', 'Lost ACK must transition to unknown, NOT failed');
            }
          );
        }
      );
    } finally {
      await unlink(keyfilePath).catch(() => {});
    }
  });

  test('restart/replay with existing signed payload resubmits only identical bytes and does not re-sign', async () => {
    const { order, raw, hash } = await createTestExecutionOrder();
    order.status = 'unknown'; // Previously interrupted
    order.signedPayload = JSON.stringify({ raw, hash, kind: 'evm' });
    order.txHash = hash;

    const { store, orders, callLog } = createMemoryTradeStore(order);
    let sentRaw = '';

    const rpc = makeRpc({
      eth_chainId: '0x1',
      eth_getTransactionReceipt: () => null,
      eth_getTransactionByHash: () => null,
      eth_sendRawTransaction: (params: unknown[]) => {
        sentRaw = String(params[0]);
        return hash;
      },
    });

    await withEnv(
      {
        TRADE_EVM_MEV_PROTECTED: 'true',
        TELEGRAM_ALLOWED_USER_IDS: '1001',
        TELEGRAM_ALLOWED_CHAT_IDS: '-2001',
      },
      async () => {
        const ran = await runTradeOnce(store, policy, rpc);
        assert.equal(ran, true);

        // Verify that writeSigned was NEVER called again (no re-signing!)
        assert.equal(callLog.some(c => c.startsWith('writeSigned')), false, 'Replay must not re-sign');
        assert.equal(sentRaw, raw, 'Resubmitted payload must be byte-for-byte identical');
        assert.equal(orders.get(order.id)?.status, 'submitted');
      }
    );
  });

});
