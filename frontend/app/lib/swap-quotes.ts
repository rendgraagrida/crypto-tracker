import { PublicKey } from '@solana/web3.js';
import { getAddress, Interface } from 'ethers';
import { boundedFetch } from './bounded-fetch.ts';
import type { ApiInstruction, EvmBuild, SolanaBuild, SwapQuote, SwapRequest } from './trade-types.ts';

export const ALLOWANCE_HOLDER = '0x0000000000001ff3684f28c67538d4d072c22734';
export const EVM_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const WSOL = 'So11111111111111111111111111111111111111112';
const CHAINS: Record<string, number> = { ethereum: 1, base: 8453, bsc: 56, polygon: 137, arbitrum: 42161, optimism: 10 };
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const MAX_UINT = (1n << 256n) - 1n;
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ASSOCIATED_TOKEN = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const HOLDER_ABI = new Interface(['function exec(address operator,address token,uint256 amount,address target,bytes data)']);
const SETTLER_ABI = new Interface(['function execute((address recipient,address buyToken,uint256 minAmountOut) slippage,bytes[] actions,bytes32 zid)']);
function fail(): never { throw new Error('Invalid or unsupported swap quote'); }
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function str(value: unknown): string { if (typeof value !== 'string' || !value) return fail(); return value; }
function uint(value: unknown, positive = false): string {
  const s = str(value);
  if (!/^(0|[1-9][0-9]{0,77})$/.test(s)) return fail();
  const n = BigInt(s);
  if (n > MAX_UINT || (positive && n === 0n)) return fail();
  return s;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return fail();
  return value;
}
function evm(value: unknown): string {
  try { return getAddress(str(value)).toLowerCase(); } catch { return fail(); }
}
function sol(value: unknown): string {
  try { const s = str(value); const p = new PublicKey(s).toBase58(); if (p !== s) return fail(); return p; } catch { return fail(); }
}
function request(value: unknown): SwapRequest {
  const r = obj(value);
  const chain = str(r.chain);
  if (chain !== 'solana' && !Object.hasOwn(CHAINS, chain)) return fail();
  const address = chain === 'solana' ? sol : evm;
  const token = (v: unknown) => typeof v === 'string' && v.toLowerCase() === 'native' ? (chain === 'solana' ? WSOL : EVM_NATIVE) : address(v);
  const inputToken = token(r.inputToken), outputToken = token(r.outputToken);
  if (inputToken === outputToken) return fail();
  const amountRaw = uint(r.amountRaw, true);
  if (chain === 'solana' && BigInt(amountRaw) > (1n << 64n) - 1n) return fail();
  return { chain, inputToken, outputToken, amountRaw, taker: address(r.taker), slippageBps: integer(r.slippageBps, 0, 9999) };
}
function limits(out: string, min: string, bps: number): void {
  const o = BigInt(uint(out, true)), m = BigInt(uint(min, true));
  const floor = o * BigInt(10000 - bps) / 10000n;
  if (floor < 1n || m > o || m < floor) fail();
}
function hex(value: unknown): string {
  const s = str(value);
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(s)) return fail();
  return s;
}
function ix(value: unknown, taker: string): ApiInstruction {
  const v = obj(value), programId = sol(v.programId);
  if (typeof v.data !== 'string') return fail();
  const data = v.data;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || Buffer.from(data, 'base64').toString('base64') !== data) return fail();
  if (!Array.isArray(v.accounts) || v.accounts.length > 256) return fail();
  const accounts = v.accounts.map((entry: unknown) => {
    const a = obj(entry), pubkey = sol(a.pubkey);
    if (typeof a.isSigner !== 'boolean' || typeof a.isWritable !== 'boolean' || (a.isSigner && pubkey !== taker)) return fail();
    return { pubkey, isSigner: a.isSigner, isWritable: a.isWritable };
  });
  return { programId, accounts, data };
}
function ixList(value: unknown, taker: string): ApiInstruction[] {
  if (!Array.isArray(value) || value.length > 64) return fail();
  return value.map((x: unknown) => ix(x, taker));
}
function solBuild(value: unknown, r: SwapRequest): SolanaBuild {
  const taker = r.taker;
  const v = obj(value);
  if (v.kind !== 'solana') return fail();
  const computeBudgetInstructions = ixList(v.computeBudgetInstructions, taker);
  for (const i of computeBudgetInstructions) {
    const bytes = Buffer.from(i.data, 'base64');
    if (i.programId !== COMPUTE || i.accounts.length !== 0 || !((bytes[0] === 2 && bytes.length === 5 && bytes.readUInt32LE(1) <= 1_400_000) || (bytes[0] === 3 && bytes.length === 9))) return fail();
  }
  const setupInstructions = ixList(v.setupInstructions, taker), otherInstructions = ixList(v.otherInstructions, taker);
  const cleanupInstruction = v.cleanupInstruction === null ? null : ix(v.cleanupInstruction, taker);
  if (otherInstructions.length) return fail();
  const associated = (mint: string, program: string) => PublicKey.findProgramAddressSync(
    [new PublicKey(taker).toBuffer(), new PublicKey(program).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN),
  )[0].toBase58();
  const wsolAccount = associated(WSOL, TOKEN);
  let funded = false;
  for (const instruction of setupInstructions) {
    const data = Buffer.from(instruction.data, 'base64'), a = instruction.accounts;
    if (instruction.programId === ASSOCIATED_TOKEN) {
      if (!(data.length === 0 || (data.length === 1 && data[0] === 1)) || a.length !== 6 ||
          a[0].pubkey !== taker || !a[0].isSigner || !a[0].isWritable ||
          a[2].pubkey !== taker || (a[3].pubkey !== r.inputToken && a[3].pubkey !== r.outputToken) ||
          a[4].pubkey !== SYSTEM || (a[5].pubkey !== TOKEN && a[5].pubkey !== TOKEN_2022) ||
          a[1].pubkey !== associated(a[3].pubkey, a[5].pubkey) || !a[1].isWritable) return fail();
    } else if (instruction.programId === SYSTEM) {
      if (funded || r.inputToken !== WSOL || data.length !== 12 || data.readUInt32LE(0) !== 2 ||
          data.readBigUInt64LE(4) !== BigInt(r.amountRaw) || a.length !== 2 ||
          a[0].pubkey !== taker || !a[0].isSigner || !a[0].isWritable ||
          a[1].pubkey !== wsolAccount || !a[1].isWritable) return fail();
      funded = true;
    } else if (instruction.programId === TOKEN) {
      if (r.inputToken !== WSOL || data.length !== 1 || data[0] !== 17 || a.length !== 1 ||
          a[0].pubkey !== wsolAccount || !a[0].isWritable) return fail();
    } else return fail();
  }
  if (cleanupInstruction) {
    const data = Buffer.from(cleanupInstruction.data, 'base64'), a = cleanupInstruction.accounts;
    if ((r.inputToken !== WSOL && r.outputToken !== WSOL) || cleanupInstruction.programId !== TOKEN ||
        data.length !== 1 || data[0] !== 9 || a.length !== 3 || a[0].pubkey !== wsolAccount ||
        !a[0].isWritable || a[1].pubkey !== taker || !a[1].isWritable ||
        a[2].pubkey !== taker || !a[2].isSigner) return fail();
  }
  const swapInstruction = ix(v.swapInstruction, taker);
  if (swapInstruction.programId !== JUPITER) return fail();
  const lookup = obj(v.addressesByLookupTableAddress), addressesByLookupTableAddress: Record<string, string[]> = {};
  for (const [key, entries] of Object.entries(lookup)) {
    sol(key);
    if (!Array.isArray(entries) || entries.length > 256) return fail();
    addressesByLookupTableAddress[key] = entries.map(sol);
  }
  return { kind: 'solana', computeBudgetInstructions, setupInstructions, swapInstruction, cleanupInstruction, otherInstructions, addressesByLookupTableAddress, blockhash: sol(v.blockhash), lastValidBlockHeight: integer(v.lastValidBlockHeight, 1, Number.MAX_SAFE_INTEGER) };
}
function evmBuild(value: unknown, r: SwapRequest): EvmBuild {
  const v = obj(value);
  if (v.kind !== 'evm' || v.chainId !== CHAINS[r.chain] || evm(v.to) !== ALLOWANCE_HOLDER) return fail();
  const allowance = v.allowance === null ? null : (() => {
    const a = obj(v.allowance), actualRaw = uint(a.actualRaw), requiredRaw = uint(a.requiredRaw, true);
    if (r.inputToken === EVM_NATIVE || evm(a.spender) !== ALLOWANCE_HOLDER || requiredRaw !== r.amountRaw || BigInt(actualRaw) >= BigInt(requiredRaw)) return fail();
    return { spender: ALLOWANCE_HOLDER, actualRaw, requiredRaw };
  })();
  const valueRaw = uint(v.value);
  if (BigInt(valueRaw) !== (r.inputToken === EVM_NATIVE ? BigInt(r.amountRaw) : 0n)) return fail();
  return { kind: 'evm', chainId: CHAINS[r.chain], to: ALLOWANCE_HOLDER, data: hex(v.data), value: valueRaw, gas: uint(v.gas, true), gasPrice: uint(v.gasPrice, true), allowance };
}

/** Validate stored JSON without extending its original lifetime. Expiry is enforced by the caller. */
export function parseSwapQuote(value: unknown): SwapQuote {
  const v = obj(value), r = request(v);
  if ((r.chain === 'solana' ? 'jupiter-v2' : '0x-v2') !== v.provider) return fail();
  const amountOutRaw = uint(v.amountOutRaw, true), minOutRaw = uint(v.minOutRaw, true);
  if (r.chain === 'solana' && BigInt(amountOutRaw) > (1n << 64n) - 1n) return fail();
  limits(amountOutRaw, minOutRaw, r.slippageBps);
  const impact = v.priceImpactBps === null ? null : integer(v.priceImpactBps, 0, 1_000_000);
  const createdAt = str(v.createdAt), expiresAt = str(v.expiresAt);
  const created = Date.parse(createdAt), expires = Date.parse(expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || new Date(created).toISOString() !== createdAt || new Date(expires).toISOString() !== expiresAt || expires <= created || expires - created > 30_000 || created > Date.now() + 1000) return fail();
  const build = r.chain === 'solana' ? solBuild(v.build, r) : evmBuild(v.build, r);
  const feeNativeRaw = v.feeNativeRaw === null ? null : uint(v.feeNativeRaw);
  if (build.kind === 'solana' ? feeNativeRaw !== null : feeNativeRaw === null || BigInt(feeNativeRaw) !== BigInt(build.gas) * BigInt(build.gasPrice)) return fail();
  return { ...r, provider: v.provider as SwapQuote['provider'], amountOutRaw, minOutRaw, priceImpactBps: impact, feeNativeRaw, feesDescription: str(v.feesDescription), createdAt, expiresAt, build };
}

/** Structural check only: action semantics still require a trusted Settler and simulation. */
export function validateEvmSwapIntent(quote: SwapQuote, allowedSettlers: readonly string[]): void {
  const q = parseSwapQuote(quote);
  if (q.build.kind !== 'evm' || allowedSettlers.length === 0) return fail();
  try {
    const allowed = allowedSettlers.map(evm);
    const outer = HOLDER_ABI.parseTransaction({ data: q.build.data });
    if (!outer || outer.name !== 'exec' || HOLDER_ABI.encodeFunctionData('exec', outer.args).toLowerCase() !== q.build.data.toLowerCase()) return fail();
    const operator = evm(outer.args[0]), token = evm(outer.args[1]), target = evm(outer.args[3]);
    if (operator !== target || !allowed.includes(operator) || token !== q.inputToken || outer.args[2] !== BigInt(q.amountRaw)) return fail();
    const data = str(outer.args[4]);
    const inner = SETTLER_ABI.parseTransaction({ data });
    if (!inner || inner.name !== 'execute' || SETTLER_ABI.encodeFunctionData('execute', inner.args).toLowerCase() !== data.toLowerCase()) return fail();
    const slippage = inner.args[0];
    if (evm(slippage[0]) !== q.taker || evm(slippage[1]) !== q.outputToken || slippage[2] < BigInt(q.minOutRaw)) return fail();
  } catch { return fail(); }
}

function impactBps(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  // Jupiter priceImpactPct is a decimal fraction (1 = 100%); round up for risk checks.
  const s = typeof value === 'number' && Number.isFinite(value) ? String(value) : str(value);
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(s) || s.length > 40) return fail();
  const [whole, fraction = ''] = s.split('.');
  const scale = 10n ** BigInt(fraction.length), numerator = BigInt(whole) * scale + BigInt(fraction || '0');
  const bps = (numerator * 10000n + scale - 1n) / scale;
  if (bps > 1_000_000n) return fail();
  return Number(bps);
}
function matchOptional(o: Record<string, unknown>, key: string, expected: string, address: (v: unknown) => string): void {
  if (o[key] !== undefined && address(o[key]) !== expected) fail();
}

export async function requestSwapQuote(input: SwapRequest): Promise<SwapQuote> {
  const r = request(input), now = Date.now();
  const createdAt = new Date(now).toISOString(), expiresAt = new Date(now + 30_000).toISOString();
  const solana = r.chain === 'solana';
  const url = new URL(solana ? 'https://api.jup.ag/swap/v2/build' : 'https://api.0x.org/swap/allowance-holder/quote');
  const params: Record<string, string> = solana ? { inputMint: r.inputToken, outputMint: r.outputToken, amount: r.amountRaw, taker: r.taker, slippageBps: String(r.slippageBps), forJitoBundle: 'true' } : { chainId: String(CHAINS[r.chain]), sellToken: r.inputToken, buyToken: r.outputToken, sellAmount: r.amountRaw, taker: r.taker, recipient: r.taker, slippageBps: String(r.slippageBps) };
  url.search = new URLSearchParams(params).toString();
  const headers: Record<string, string> = {};
  if (solana) { if (process.env.JUPITER_API_KEY) headers['x-api-key'] = process.env.JUPITER_API_KEY; }
  else { if (!process.env.ZEROX_API_KEY) throw new Error('0x API key unavailable'); headers['0x-api-key'] = process.env.ZEROX_API_KEY; headers['0x-version'] = 'v2'; }
  let value: unknown;
  try {
    const response = await boundedFetch(url, { headers, redirect: 'error' });
    if (!response.ok) throw new Error();
    value = await response.json();
  } catch { throw new Error('Swap provider unavailable or invalid response'); }
  const v = obj(value);
  let result: Record<string, unknown>;
  if (solana) {
    if (sol(v.inputMint) !== r.inputToken || sol(v.outputMint) !== r.outputToken || uint(v.inAmount, true) !== r.amountRaw || v.swapMode !== 'ExactIn' || v.slippageBps !== r.slippageBps || v.tipInstruction !== null) return fail();
    matchOptional(v, 'taker', r.taker, sol);
    const meta = obj(v.blockhashWithMetadata);
    if (!Array.isArray(meta.blockhash) || meta.blockhash.length !== 32 || meta.blockhash.some((n: unknown) => typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255)) return fail();
    const build = { kind: 'solana', computeBudgetInstructions: v.computeBudgetInstructions, setupInstructions: v.setupInstructions, swapInstruction: v.swapInstruction, cleanupInstruction: v.cleanupInstruction, otherInstructions: v.otherInstructions, addressesByLookupTableAddress: v.addressesByLookupTableAddress ?? {}, blockhash: new PublicKey(Uint8Array.from(meta.blockhash as number[])).toBase58(), lastValidBlockHeight: meta.lastValidBlockHeight };
    result = { amountOutRaw: v.outAmount, minOutRaw: v.otherAmountThreshold, priceImpactBps: impactBps(v.priceImpactPct), feeNativeRaw: null, feesDescription: 'Network fee and token taxes unknown.', build };
  } else {
    if (v.liquidityAvailable !== true || v.mode !== 'exact-in' || evm(v.sellToken) !== r.inputToken || evm(v.buyToken) !== r.outputToken || uint(v.sellAmount, true) !== r.amountRaw) return fail();
    if (v.chainId !== undefined && v.chainId !== CHAINS[r.chain]) return fail();
    matchOptional(v, 'taker', r.taker, evm); matchOptional(v, 'recipient', r.taker, evm);
    const issues = obj(v.issues), tx = obj(v.transaction);
    if (issues.simulationIncomplete !== false || !Array.isArray(issues.invalidSourcesPassed) || issues.invalidSourcesPassed.length || issues.balance !== null) return fail();
    matchOptional(tx, 'from', r.taker, evm);
    if (v.allowanceTarget !== null && evm(v.allowanceTarget) !== ALLOWANCE_HOLDER) return fail();
    let allowance = null;
    if (issues.allowance !== null) {
      const a = obj(issues.allowance);
      if (evm(a.spender) !== ALLOWANCE_HOLDER || evm(v.allowanceTarget) !== ALLOWANCE_HOLDER) return fail();
      allowance = { spender: ALLOWANCE_HOLDER, actualRaw: uint(a.actual), requiredRaw: r.amountRaw };
    }
    const gas = uint(tx.gas, true), gasPrice = uint(tx.gasPrice, true);
    result = { amountOutRaw: v.buyAmount, minOutRaw: v.minBuyAmount, priceImpactBps: null, feeNativeRaw: (BigInt(gas) * BigInt(gasPrice)).toString(), feesDescription: 'Gas limit × gas price; L1 data fees, swap fees and token taxes unknown.', build: { kind: 'evm', chainId: CHAINS[r.chain], to: tx.to, data: tx.data, value: tx.value, gas, gasPrice, allowance } };
  }
  return parseSwapQuote({ ...r, provider: solana ? 'jupiter-v2' : '0x-v2', ...result, createdAt, expiresAt });
}
