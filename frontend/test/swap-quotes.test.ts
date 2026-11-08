import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { Interface } from 'ethers';
import { ALLOWANCE_HOLDER, WSOL, parseSwapQuote, requestSwapQuote, validateEvmSwapIntent } from '../app/lib/swap-quotes.ts';
import type { SwapRequest } from '../app/lib/trade-types.ts';

const taker = '0x1111111111111111111111111111111111111111';
const sell = '0x2222222222222222222222222222222222222222';
const buy = '0x3333333333333333333333333333333333333333';
const settler = '0x4444444444444444444444444444444444444444';
const large = '900719925474099312345678901234';
const request: SwapRequest = { chain: 'base', inputToken: sell, outputToken: buy, amountRaw: large, taker, slippageBps: 100 };
const holder = new Interface(['function exec(address operator,address token,uint256 amount,address target,bytes data)']);
const inner = new Interface(['function execute((address recipient,address buyToken,uint256 minAmountOut),bytes[],bytes32)']);
function calldata(recipient = taker, token = buy, minimum = 9900n, operator = settler): string {
  const data = inner.encodeFunctionData('execute', [[recipient, token, minimum], [], '0x' + '00'.repeat(32)]);
  return holder.encodeFunctionData('exec', [operator, sell, BigInt(large), settler, data]);
}
function evmResponse(): Record<string, unknown> {
  return { liquidityAvailable: true, mode: 'exact-in', sellToken: sell, buyToken: buy, sellAmount: large, buyAmount: '10000', minBuyAmount: '9900', allowanceTarget: ALLOWANCE_HOLDER, issues: { simulationIncomplete: false, invalidSourcesPassed: [], balance: null, allowance: { spender: ALLOWANCE_HOLDER, actual: '0' } }, transaction: { to: ALLOWANCE_HOLDER, from: taker, data: calldata(), value: '0', gas: '21000', gasPrice: '1000000000' } };
}
const solTaker = '11111111111111111111111111111111';
const solOutput = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const solRequest: SwapRequest = { chain: 'solana', inputToken: 'native', outputToken: solOutput, amountRaw: '1234567890123456789', taker: solTaker, slippageBps: 100 };
function jupiterResponse(): Record<string, unknown> {
  return { inputMint: WSOL, outputMint: solOutput, inAmount: solRequest.amountRaw, outAmount: '10000', otherAmountThreshold: '9900', swapMode: 'ExactIn', slippageBps: 100, priceImpactPct: '0.00101', computeBudgetInstructions: [{ programId: 'ComputeBudget111111111111111111111111111111', accounts: [], data: 'AkBCDwA=' }], setupInstructions: [], swapInstruction: { programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', accounts: [], data: 'AQ==' }, cleanupInstruction: null, otherInstructions: [], tipInstruction: null, addressesByLookupTableAddress: null, blockhashWithMetadata: { blockhash: Array(32).fill(0), lastValidBlockHeight: 123 } };
}
async function withProvider<T>(payload: unknown, callback: (seen: { url: URL; init: RequestInit | undefined }[]) => Promise<T>): Promise<T> {
  const old = globalThis.fetch, key = process.env.ZEROX_API_KEY;
  const seen: { url: URL; init: RequestInit | undefined }[] = [];
  process.env.ZEROX_API_KEY = 'fixture-key';
  globalThis.fetch = async (url, init) => { seen.push({ url: new URL(String(url)), init }); return new Response(JSON.stringify(payload)); };
  try { return await callback(seen); } finally { globalThis.fetch = old; if (key === undefined) delete process.env.ZEROX_API_KEY; else process.env.ZEROX_API_KEY = key; }
}

test('0x quote binds requested fields, retains exact units, allowance and expiry', async () => {
  await withProvider(evmResponse(), async seen => {
    const q = await requestSwapQuote(request);
    assert.equal(seen[0].url.origin, 'https://api.0x.org');
    assert.equal(seen[0].url.searchParams.get('recipient'), taker);
    assert.equal(seen[0].url.searchParams.get('sellAmount'), large);
    assert.equal(seen[0].init?.redirect, 'error');
    assert.equal(q.amountRaw, large);
    assert.equal(q.priceImpactBps, null);
    assert.equal(q.feeNativeRaw, '21000000000000');
    assert.equal(q.build.kind === 'evm' && q.build.allowance?.requiredRaw, large);
    assert.equal(parseSwapQuote(JSON.parse(JSON.stringify(q))).expiresAt, q.expiresAt);
    validateEvmSwapIntent(q, [settler]);
    assert.throws(() => validateEvmSwapIntent(q, []));
    assert.throws(() => validateEvmSwapIntent(q, [taker]));
    if (q.build.kind !== 'evm') throw new Error('wrong build');
    const build = q.build;
    for (const data of [calldata(sell), calldata(taker, sell), calldata(taker, buy, 9899n), calldata(taker, buy, 9900n, sell), '0x1234']) {
      assert.throws(() => validateEvmSwapIntent({ ...q, build: { ...build, data } }, [settler]));
    }
  });
});

test('0x fails closed for mismatches, invalid issues and malformed transaction', async () => {
  const cases: Record<string, unknown>[] = [
    { chainId: 1 }, { sellToken: buy }, { buyToken: sell }, { sellAmount: '1' }, { recipient: sell }, { taker: sell },
    { minBuyAmount: '9899' }, { minBuyAmount: '0' }, { liquidityAvailable: false }, { mode: 'exact-out' },
    { allowanceTarget: sell }, { issues: { simulationIncomplete: true, invalidSourcesPassed: [], balance: null, allowance: null } },
    { issues: { simulationIncomplete: false, invalidSourcesPassed: ['bad'], balance: null, allowance: null } },
    { issues: { simulationIncomplete: false, invalidSourcesPassed: [], balance: null, allowance: { actual: '0', spender: sell } } },
    { transaction: { to: sell, data: '0x12', value: '0', gas: '1', gasPrice: '1' } },
    { transaction: { to: ALLOWANCE_HOLDER, from: sell, data: '0x12', value: '0', gas: '1', gasPrice: '1' } },
    { transaction: { to: ALLOWANCE_HOLDER, data: '0x1', value: '0', gas: '1', gasPrice: '1' } },
    { transaction: { to: ALLOWANCE_HOLDER, data: '0x12', value: '0', gasPrice: '1' } },
  ];
  for (const patch of cases) await withProvider({ ...evmResponse(), ...patch }, async () => { await assert.rejects(requestSwapQuote(request)); });
});

test('slippage minimum uses nonzero floor in atomic token units', async () => {
  await withProvider({ ...evmResponse(), buyAmount: '10001', minBuyAmount: '9900' }, async () => {
    assert.equal((await requestSwapQuote(request)).minOutRaw, '9900');
  });
  await withProvider({ ...evmResponse(), buyAmount: '10001', minBuyAmount: '9899' }, async () => {
    await assert.rejects(requestSwapQuote(request));
  });
  await withProvider({ ...evmResponse(), buyAmount: '1', minBuyAmount: '1' }, async () => {
    await assert.rejects(requestSwapQuote(request));
  });
});

test('Jupiter v2 validates build, normalizes native and reports unknown fee', async () => {
  await withProvider(jupiterResponse(), async seen => {
    const q = await requestSwapQuote(solRequest);
    assert.equal(seen[0].url.href.startsWith('https://api.jup.ag/swap/v2/build?'), true);
    assert.equal(seen[0].url.searchParams.get('forJitoBundle'), 'true');
    assert.equal(q.inputToken, WSOL);
    assert.equal(q.priceImpactBps, 11);
    assert.equal(q.feeNativeRaw, null);
    assert.equal(q.build.kind === 'solana' && q.build.blockhash, solTaker);
  });
  const hiddenTip = Buffer.alloc(12);
  hiddenTip.writeUInt32LE(2);
  hiddenTip.writeBigUInt64LE(BigInt(solRequest.amountRaw), 4);
  const wsolAccount = PublicKey.findProgramAddressSync([
    new PublicKey(solTaker).toBuffer(),
    new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(),
    new PublicKey(WSOL).toBuffer(),
  ], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0].toBase58();
  const funding = { programId: solTaker, accounts: [
    { pubkey: solTaker, isSigner: true, isWritable: true },
    { pubkey: wsolAccount, isSigner: false, isWritable: true },
  ], data: hiddenTip.toString('base64') };
  await withProvider({ ...jupiterResponse(), setupInstructions: [funding] }, async () => {
    assert.equal((await requestSwapQuote(solRequest)).build.kind, 'solana');
  });
  await withProvider({ ...jupiterResponse(), setupInstructions: [funding, funding] }, async () => {
    await assert.rejects(requestSwapQuote(solRequest));
  });
  const cases: Record<string, unknown>[] = [
    { inputMint: solOutput }, { inAmount: '1' }, { swapMode: 'ExactOut' }, { slippageBps: 200 },
    { otherAmountThreshold: '9899' }, { tipInstruction: {} }, { otherInstructions: [{}] },
    { swapInstruction: { programId: solTaker, accounts: [], data: 'AQ==' } },
    { computeBudgetInstructions: [{ programId: solTaker, accounts: [], data: 'AQ==' }] },
    { setupInstructions: [{ programId: solTaker, accounts: [
      { pubkey: solTaker, isSigner: true, isWritable: true },
      { pubkey: solOutput, isSigner: false, isWritable: true },
    ], data: hiddenTip.toString('base64') }] },
    { blockhashWithMetadata: { blockhash: [1], lastValidBlockHeight: 1 } },
  ];
  for (const patch of cases) await withProvider({ ...jupiterResponse(), ...patch }, async () => { await assert.rejects(requestSwapQuote(solRequest)); });
});

test('persisted quotes are validated independently without refreshing expiration', async () => {
  await withProvider(evmResponse(), async () => {
    const q = await requestSwapQuote(request);
    const old = { ...q, createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:00:30.000Z' };
    assert.equal(parseSwapQuote(old).expiresAt, old.expiresAt);
    assert.throws(() => parseSwapQuote({ ...q, minOutRaw: '1' }));
    assert.throws(() => parseSwapQuote({ ...q, expiresAt: '2100-01-01T00:00:00.000Z' }));
    assert.throws(() => parseSwapQuote({ ...q, build: { ...q.build, data: 'bad' } }));
    assert.throws(() => parseSwapQuote({ ...q, amountRaw: '1e30' }));
    assert.throws(() => parseSwapQuote({ ...q, chain: 'other' }));
  });
});

test('rejects invalid inputs before contacting a provider and sanitizes transport errors', async () => {
  await withProvider(evmResponse(), async seen => {
    for (const patch of [{ chain: 'unknown' }, { inputToken: buy }, { amountRaw: '0' }, { amountRaw: '1e18' }, { slippageBps: -1 }, { slippageBps: 10000 }, { taker: 'bad' }]) {
      await assert.rejects(requestSwapQuote({ ...request, ...patch }));
    }
    assert.equal(seen.length, 0);
  });
  const old = globalThis.fetch, key = process.env.ZEROX_API_KEY;
  process.env.ZEROX_API_KEY = 'fixture-key';
  globalThis.fetch = async () => { throw new Error('sensitive provider details'); };
  try {
    await assert.rejects(requestSwapQuote(request), error => error instanceof Error && !error.message.includes('sensitive'));
    globalThis.fetch = async () => new Response('not-json', { status: 200 });
    await assert.rejects(requestSwapQuote(request));
    globalThis.fetch = async () => new Response('secret error', { status: 503 });
    await assert.rejects(requestSwapQuote(request));
  } finally { globalThis.fetch = old; if (key === undefined) delete process.env.ZEROX_API_KEY; else process.env.ZEROX_API_KEY = key; }
});
