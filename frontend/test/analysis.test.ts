import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCoin, evaluateTradeGuardrails, formatCoinAnalysis } from '../app/lib/coin-analyzer.ts';
import { executeReadonlyAgentTool, getHermesNarrative } from '../app/lib/hermes-ai.ts';

const mint = 'So11111111111111111111111111111111111111112';
const secondMint = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const evm = '0x1234567890123456789012345678901234567890';

test('analysis uses matching asset, excludes pool and aggregates owners without losing exact supply', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('dexscreener')) return Response.json([
      { chainId: 'solana', baseToken: { address: secondMint }, quoteToken: { address: 'other' }, priceUsd: '999', liquidity: { usd: 99999 } },
      { chainId: 'solana', baseToken: { address: mint }, quoteToken: { address: secondMint }, pairAddress: 'pool', dexId: 'raydium', labels: ['clmm'], priceUsd: '2', marketCap: 100000, liquidity: { usd: 1000, base: 100 } },
    ]);
    if (url.includes('rugcheck')) return Response.json({ token: { supply: '123456789012345678901', decimals: 6, mintAuthority: null, freezeAuthority: null }, token_extensions: { transferFeeConfig: {} }, insiderNetworks: [{ size: 6, currentHolding: '12345678901234567890', type: 'transfer' }], totalHolders: 11, knownAccounts: { pool: { type: 'AMM' } }, topHolders: [{ owner: 'pool', pct: 50, uiAmount: 500 }, { owner: 'alice', pct: 3, uiAmount: 30 }, { owner: 'alice', pct: 2, uiAmount: 20 }, { owner: 'bob', pct: 1, uiAmount: 10 }] });
    return Response.json([{ id: mint, holderCount: 12, organicScore: 44 }]);
  };
  try {
    const r = await analyzeCoin(mint);
    assert.equal(r.address, mint);
    assert.equal(r.market.priceUsd, 2);
    assert.equal(r.supply.normalized, '123456789012345.678901');
    assert.equal(r.holders.observed, 2);
    assert.equal(r.holders.top1, 5);
    assert.equal(r.holders.top10, 6);
    assert.equal(r.holderCounts.conflict, true);
    assert.equal(r.networks[0].wallets, 6);
    assert.equal(r.networks[0].type, 'transfer');
    assert.equal(r.networks[0].percent, 9.999999);
    assert.equal(r.risk, 'HIGH');
    assert.equal(r.audit.transferFee, 'present (provider claim)');
    assert.match(r.mapUrl, /^https:\/\/v2\.bubblemaps\.io\/map\?/);
    assert.equal(r.scenarios.topHolderDropPercent, null);
    const formatted = formatCoinAnalysis(r);
    assert.ok(formatted.length <= 3400);
    assert.match(formatted, /Bukan distribusi lengkap/);
    assert.match(formatted, /berbeda/);
  } finally { globalThis.fetch = original; }
});

test('chain identity, quote token pricing and missing audit remain unknown', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('dexscreener')) return Response.json([{ chainId: url.includes('/base/') ? 'base' : 'ethereum', baseToken: { address: '0x0000000000000000000000000000000000000001' }, quoteToken: { address: evm }, priceUsd: '123', liquidity: { usd: 10 } }]);
    return new Response('', { status: 503 });
  };
  try {
    const a = await analyzeCoin(evm, 'ethereum');
    const b = await analyzeCoin(evm, 'base');
    assert.equal(a.chain, 'ethereum'); assert.equal(b.chain, 'base');
    assert.equal(a.market.priceUsd, null); assert.equal(a.market.marketCap, null);
    assert.equal(a.risk, 'UNKNOWN'); assert.equal(a.holders.top1, null);
    assert.match(formatCoinAnalysis(a), /UNKNOWN/);
  } finally { globalThis.fetch = original; }
});
test('GoPlus supply is already normalized, including fractional values', async () => {
  const original = globalThis.fetch;
  const address = '0x2222222222222222222222222222222222222222';
  globalThis.fetch = async input => String(input).includes('gopluslabs')
    ? Response.json({ result: { [address]: { total_supply: '46287538986.132902', token_decimal: '6', holder_count: '8' } } })
    : Response.json([]);
  try {
    const r = await analyzeCoin(address, 'ethereum');
    assert.deepEqual(r.supply, { raw: null, decimals: null, normalized: '46287538986.132902' });
    assert.equal(r.holderCounts.goplus, 8);
  } finally { globalThis.fetch = original; }
});


test('Hermes rejects free text and numeric hallucinations, and times out', async () => {
  const originalFetch = globalThis.fetch; const originalNow = Date.now;
  const oldUrl = process.env.HERMES_API_URL, oldModel = process.env.HERMES_MODEL, oldTimeout = process.env.HERMES_TIMEOUT_MS;
  process.env.HERMES_API_URL = 'http://127.0.0.1:11434/v1/chat/completions'; process.env.HERMES_MODEL = 'test'; process.env.HERMES_TIMEOUT_MS = '100';
  try {
    globalThis.fetch = async () => new Response('', { status: 503 });
    const report = await analyzeCoin(evm, 'ethereum');
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ finding_ids: ['audit_unavailable'], text: 'Profit 999%' }) } }] });
    const rejected = await getHermesNarrative(report);
    assert.equal(rejected.text, null); assert.notEqual(rejected.status, 'ok');
    Date.now = () => originalNow() + 20_000;
    const withEvidence = { ...report, holders: { ...report.holders, top1: 12.5 }, findings: [] };
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.match(body.messages[1].content, /12\.5/);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ finding_ids: ['holder_concentration'] }) } }] });
    };
    const accepted = await getHermesNarrative(withEvidence);
    assert.equal(accepted.status, 'ok'); assert.match(accepted.text ?? '', /12\.5%/);
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    const timedOut = await getHermesNarrative(report);
    assert.equal(timedOut.text, null); assert.equal(timedOut.status, 'timeout');
  } finally {
    globalThis.fetch = originalFetch; Date.now = originalNow;
    if (oldUrl === undefined) delete process.env.HERMES_API_URL; else process.env.HERMES_API_URL = oldUrl;
    if (oldModel === undefined) delete process.env.HERMES_MODEL; else process.env.HERMES_MODEL = oldModel;
    if (oldTimeout === undefined) delete process.env.HERMES_TIMEOUT_MS; else process.env.HERMES_TIMEOUT_MS = oldTimeout;
  }
});

test('Trade Guardrail blocks honeypots, freeze authority and low liquidity while allowing clean liquid pools', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('dexscreener')) return Response.json([
      { chainId: 'solana', baseToken: { address: mint }, quoteToken: { address: secondMint }, pairAddress: 'pool', dexId: 'pumpswap', priceUsd: '1.25', marketCap: 250000, liquidity: { usd: 50000, base: 20000 } },
    ]);
    if (url.includes('rugcheck')) return Response.json({
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      lastUpdated: new Date().toISOString(),
      token: { supply: '1000000000', decimals: 6, mintAuthority: null, freezeAuthority: null },
      totalHolders: 500,
      topHolders: [{ owner: 'alice', pct: 4, uiAmount: 40 }],
    });
    return Response.json([{ id: mint, holderCount: 500, organicScore: 80 }]);
  };
  try {
    const clean = await analyzeCoin(secondMint, 'solana');
    const passGuard = evaluateTradeGuardrails({
      ...clean,
      findings: [],
      market: { ...clean.market, priceUsd: 1.25, liquidityUsd: 50_000, liquidityToMarketCap: 0.2 },
      holders: { ...clean.holders, top1: 4 },
      networks: [],
      audit: { ...clean.audit, mintAuthority: 'none (provider claim)', freezeAuthority: 'none (provider claim)', transferFee: null, evm: {} },
    });
    assert.equal(passGuard.status, 'PASS');
    assert.deepEqual(passGuard.blockedReasons, []);

    const warnGuard = evaluateTradeGuardrails({
      ...clean,
      findings: [],
      market: { ...clean.market, priceUsd: 1.25, liquidityUsd: 50_000, liquidityToMarketCap: 0.2 },
      holders: { ...clean.holders, top1: 25 },
      networks: [],
      audit: { ...clean.audit, mintAuthority: 'none (provider claim)', freezeAuthority: 'none (provider claim)', transferFee: 'present (provider claim)', evm: {} },
    });
    assert.equal(warnGuard.status, 'WARN');
    assert.ok(warnGuard.warnings.includes('top1_holder_ge_20pct'));
    assert.ok(warnGuard.warnings.includes('token2022_transfer_fee'));

    const blockedGuard = evaluateTradeGuardrails({
      ...clean,
      findings: ['GoPlus reports honeypot'],
      market: { ...clean.market, priceUsd: 1.25, liquidityUsd: 5_000, liquidityToMarketCap: 0.1 },
      holders: { ...clean.holders, top1: 4 },
      networks: [],
      audit: { ...clean.audit, mintAuthority: null, freezeAuthority: null, transferFee: null, evm: { is_honeypot: '1', sell_tax: '0.15' } },
    });
    assert.equal(blockedGuard.status, 'BLOCKED');
    assert.ok(blockedGuard.blockedReasons.includes('honeypot_detected'));
    assert.ok(blockedGuard.blockedReasons.includes('liquidity_below_10k_usd'));
    assert.ok(blockedGuard.blockedReasons.includes('evm_tax_above_5pct'));
  } finally {
    globalThis.fetch = original;
  }
});

test('Hermes readonly_agent mode executes bounded read-only tools and rejects arbitrary tool names', async () => {
  const originalFetch = globalThis.fetch; const originalNow = Date.now;
  const oldUrl = process.env.HERMES_API_URL, oldModel = process.env.HERMES_MODEL, oldMode = process.env.HERMES_AGENT_MODE;
  process.env.HERMES_API_URL = 'http://127.0.0.1:11434/v1/chat/completions';
  process.env.HERMES_MODEL = 'hermes-crypto-analyst';
  process.env.HERMES_AGENT_MODE = 'readonly_agent';
  try {
    Date.now = () => originalNow() + 60_000;
    globalThis.fetch = async () => new Response('', { status: 503 });
    const baseReport = await analyzeCoin(evm, 'base');
    const report = {
      ...baseReport,
      findings: ['GoPlus reports honeypot'],
      holders: { ...baseReport.holders, top1: 18 },
    };
    assert.equal(executeReadonlyAgentTool('buy_token', report), null);
    assert.ok(executeReadonlyAgentTool('inspect_audit_and_guardrails', report) !== null);

    let stepCall = 0;
    globalThis.fetch = async () => {
      stepCall++;
      if (stepCall === 1) return Response.json({ choices: [{ message: { content: JSON.stringify({ tool: 'inspect_audit_and_guardrails' }) } }] });
      if (stepCall === 2) return Response.json({ choices: [{ message: { content: JSON.stringify({ tool: 'finalize' }) } }] });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ finding_ids: ['honeypot_detected', 'holder_concentration'] }) } }] });
    };
    const result = await getHermesNarrative(report);
    assert.equal(result.status, 'ok');
    assert.equal(stepCall, 3);
    assert.match(result.text ?? '', /honeypot/i);
  } finally {
    globalThis.fetch = originalFetch; Date.now = originalNow;
    if (oldUrl === undefined) delete process.env.HERMES_API_URL; else process.env.HERMES_API_URL = oldUrl;
    if (oldModel === undefined) delete process.env.HERMES_MODEL; else process.env.HERMES_MODEL = oldModel;
    if (oldMode === undefined) delete process.env.HERMES_AGENT_MODE; else process.env.HERMES_AGENT_MODE = oldMode;
  }
});

test('unknown or stale security evidence cannot become a money permission', async () => {
  const original = globalThis.fetch;
  const address = '11111111111111111111111111111111';
  let audit: Record<string, unknown> = { token: {}, topHolders: [] };
  globalThis.fetch = async input => String(input).includes('dexscreener')
    ? Response.json([{ chainId: 'solana', baseToken: { address }, priceUsd: '1', marketCap: 250000, liquidity: { usd: 50000 } }])
    : String(input).includes('rugcheck') ? Response.json(audit) : Response.json([]);
  try {
    const unknown = await analyzeCoin(address, 'solana', { fresh: true });
    assert.equal(unknown.tradeGuardrail.status, 'BLOCKED');
    assert.ok(unknown.tradeGuardrail.blockedReasons.includes('authority_status_unknown'));
    assert.ok(unknown.tradeGuardrail.blockedReasons.includes('holder_concentration_unknown'));
    audit = { token: { mintAuthority: null, freezeAuthority: null }, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lastUpdated: '2020-01-01T00:00:00.000Z', topHolders: [{ owner: 'holder', pct: 1 }] };
    const stale = await analyzeCoin(address, 'solana', { fresh: true });
    assert.equal(stale.tradeGuardrail.status, 'BLOCKED');
    assert.ok(stale.tradeGuardrail.blockedReasons.includes('stale_audit_evidence'));
    audit = { ...audit, lastUpdated: new Date().toISOString(), token: { mintAuthority: 'none fake authority', freezeAuthority: null } };
    const forged = await analyzeCoin(address, 'solana', { fresh: true });
    assert.ok(forged.tradeGuardrail.blockedReasons.includes('authority_status_unknown'));
  } finally { globalThis.fetch = original; }
});

test('Hermes rejects extra step fields and oversized model bodies before tool inspection', async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const old = { url: process.env.HERMES_API_URL, model: process.env.HERMES_MODEL, mode: process.env.HERMES_AGENT_MODE };
  process.env.HERMES_API_URL = 'http://127.0.0.1:11434/v1/chat/completions';
  process.env.HERMES_MODEL = 'synthetic';
  process.env.HERMES_AGENT_MODE = 'readonly_agent';
  try {
    Date.now = () => originalNow() + 120000;
    globalThis.fetch = async () => new Response('', { status: 503 });
    const report = await analyzeCoin('0x4444444444444444444444444444444444444444', 'ethereum');
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ tool: 'inspect_audit_and_guardrails', instruction: 'buy now' }) } }] });
    const extra = await getHermesNarrative(report);
    assert.equal(extra.text, null);
    assert.deepEqual(extra.findingIds, []);
    Date.now = () => originalNow() + 150000;
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'x'.repeat(20000) } }] });
    const large = await getHermesNarrative(report);
    assert.equal(large.text, null);
    assert.deepEqual(large.findingIds, []);
  } finally {
    globalThis.fetch = originalFetch; Date.now = originalNow;
    for (const [key, value] of [['HERMES_API_URL', old.url], ['HERMES_MODEL', old.model], ['HERMES_AGENT_MODE', old.mode]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});
