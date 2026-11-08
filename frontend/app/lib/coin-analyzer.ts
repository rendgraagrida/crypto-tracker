import { escapeHtml, normalizeAddress, normalizeChain } from './auth.ts';
import { readBoundedJson } from './bounded-json.ts';

type Source = { status: string; url: string; updatedAt: string | null };
type Holder = { owner: string; percent: number; amount: number | null };
export type TradeGuardrail = { status: 'PASS' | 'WARN' | 'BLOCKED'; blockedReasons: string[]; warnings: string[] };
export type CoinAnalysis = {
  chain: string; address: string; fetchedAt: string;
  sources: Record<string, Source>;
  market: { priceUsd: number | null; marketCap: number | null; fdv: number | null; liquidityUsd: number | null; volume24h: number | null; buys24h: number | null; sells24h: number | null; pairAddress: string | null; dex: string | null; poolCreatedAt: string | null; liquidityToMarketCap: number | null };
  supply: { raw: string | null; decimals: number | null; normalized: string | null };
  holderCounts: { rugcheck: number | null; jupiter: number | null; goplus: number | null; conflict: boolean };
  holders: { observed: number; observedPercent: number | null; top1: number | null; top5: number | null; top10: number | null; wallets: Holder[]; coverage: string };
  networks: { id: string | null; type: string | null; wallets: number | null; percent: number | null }[];
  organic: { score: number | null; label: string | null; buyRatio: number | null; devMints: number | null; devMigrations: number | null };
  audit: { mintAuthority: string | null; freezeAuthority: string | null; token2022: boolean | null; transferFee: string | null; evm: Record<string, string>; primaryLpLockClaimPercent: number | null };
  scenarios: { topHolderDropPercent: number | null; largestNetworkDropPercent: number | null; assumptions: string };
  risk: 'UNKNOWN' | 'MEDIUM' | 'HIGH'; findings: string[]; tradeGuardrail: TradeGuardrail; mapUrl: string;
};

type Json = {
  [key: string]: unknown;
  baseToken?: Json; quoteToken?: Json; liquidity?: Json; volume?: Json;
  txns?: { h24?: Json }; token?: Json; result?: Record<string, Json>;
  stats24h?: Json; audit?: Json; lp?: Json; tokenExtensions?: Json;
  knownAccounts?: Record<string, unknown>; wallets?: unknown[]; accounts?: unknown[];
};
const chainIds: Record<string, string> = { ethereum: '1', base: '8453', bsc: '56', polygon: '137', arbitrum: '42161', optimism: '10' };
const cache = new Map<string, { expires: number; value: CoinAnalysis }>();
const inflight = new Map<string, Promise<CoinAnalysis>>();
const number = (v: unknown): number | null => {
  if ((typeof v !== 'string' && typeof v !== 'number') || v === '') return null;
  const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null;
};
const text = (v: unknown): string | null => typeof v === 'string' && v.length ? v.slice(0, 200) : null;
const date = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};
function normalized(raw: unknown, decimals: unknown): { raw: string | null; decimals: number | null; normalized: string | null } {
  const r = typeof raw === 'string' && /^\d+$/.test(raw) ? raw : typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : null;
  const d = number(decimals);
  if (!r || d === null || !Number.isInteger(d) || d > 255) return { raw: r, decimals: d !== null && Number.isInteger(d) && d <= 255 ? d : null, normalized: null };
  const padded = r.padStart(d + 1, '0');
  const value = d ? `${padded.slice(0, -d)}.${padded.slice(-d)}`.replace(/\.?0+$/, '') : padded;
  return { raw: r, decimals: d, normalized: value || '0' };
}
let activeRequests = 0;
const rugCache = new Map<string, { expires: number; result: { data: unknown; status: string; url: string } }>();
const rugInflight = new Map<string, Promise<{ data: unknown; status: string; url: string }>>();
export async function fetchRugcheckReport(input: string): Promise<{ data: unknown; status: string; url: string }> {
  const address = normalizeAddress('solana', input);
  const url = `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(address)}/report`;
  const cached = rugCache.get(address);
  if (cached && cached.expires > Date.now()) return cached.result;
  const pending = rugInflight.get(address);
  if (pending) return pending;
  const task = request(url).then(result => {
    const value = { ...result, url };
    if (rugCache.size >= 200) rugCache.delete(rugCache.keys().next().value!);
    rugCache.set(address, { result: value, expires: Date.now() + (result.status === 'ok' ? 60_000 : 5_000) });
    return value;
  }).finally(() => rugInflight.delete(address));
  rugInflight.set(address, task);
  return task;
}
async function request(url: string, apiKey?: string): Promise<{ data: unknown; status: string }> {
  if (activeRequests >= 8) return { data: null, status: 'busy' };
  activeRequests++;
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'error', headers });
    if (!response.ok) return { data: null, status: `HTTP ${response.status}` };
    const data = await readBoundedJson(response.body, 1_000_000, 4000);
    return { data, status: 'ok' };
  } catch { return { data: null, status: 'unavailable' }; } finally { activeRequests--; }
}
const same = (a: unknown, b: unknown, chain: string) => typeof a === 'string' && typeof b === 'string' && (chain === 'solana' ? a === b : a.toLowerCase() === b.toLowerCase());

async function collect(address: string, chain: string, fresh = false): Promise<CoinAnalysis> {
  const dexUrl = `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`;
  const auditUrl = chain === 'solana' ? `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(address)}/report` : `https://api.gopluslabs.io/api/v1/token_security/${chainIds[chain]}?contract_addresses=${encodeURIComponent(address)}`;
  const jupUrl = `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(address)}`;
  const [dex, security, jup] = await Promise.all([request(dexUrl), chain === 'solana' && !fresh ? fetchRugcheckReport(address) : request(auditUrl), chain === 'solana' ? request(jupUrl, process.env.JUPITER_API_KEY) : Promise.resolve({ data: null, status: 'not applicable' })]);
  const pairs: Json[] = Array.isArray(dex.data) ? dex.data.filter((p: unknown): p is Json => !!p && typeof p === 'object' && !Array.isArray(p)).filter((p: Json) => p.chainId === chain && (same(p.baseToken?.address, address, chain) || same(p.quoteToken?.address, address, chain))) : [];
  pairs.sort ( (a, b) => (number(b.liquidity?.usd) ?? -1) - (number(a.liquidity?.usd) ?? -1));
  const pair = pairs[0]; const base = same(pair?.baseToken?.address, address, chain);
  // DexScreener priceUsd describes the base token only.
  const price = base ? number(pair?.priceUsd) : null;
  const rugData: Json = chain === 'solana' && security.data && typeof security.data === 'object' ? security.data as Json : {};
  const rug: Json = rugData.mint && !same(rugData.mint, address, chain) ? {} : rugData;
  const evmData = chain !== 'solana' && security.data && typeof security.data === 'object' ? security.data as Json : {};
  const evm: Json = evmData.result?.[address.toLowerCase()] ?? {};
  const j: Json = Array.isArray(jup.data) ? jup.data.find((x: Json) => x && typeof x === 'object' && same(x.id, address, chain)) ?? {} : {};
  const known = new Set<string>();
  if (typeof pair?.pairAddress === 'string') known.add(pair.pairAddress);
  for (const [key, value] of Object.entries(rug.knownAccounts ?? {})) {
    const entry = value as Json; if (/amm|pool|liquidity/i.test(String(entry?.type ?? ''))) known.add(key);
  }
  const owners = new Map<string, Holder>();
  const list: Json[] = (chain === 'solana' ? (Array.isArray(rug.topHolders) ? rug.topHolders : []) : (Array.isArray(evm.holders) ? evm.holders : [])).filter((h: unknown): h is Json => !!h && typeof h === 'object' && !Array.isArray(h));
  for (const h of list) {
    const owner = text(chain === 'solana' ? h.owner : h.address); const account = text(h.address);
    if (!owner || known.has(owner) || (account && known.has(account))) continue;
    const pct = number(chain === 'solana' ? h.pct : h.percent); if (pct === null) continue;
    const share = chain === 'solana' ? pct : pct * 100; if (share > 100) continue;
    const key = chain === 'solana' ? owner : owner.toLowerCase(); const old = owners.get(key);
    const amount = number(h.uiAmount);
    owners.set(key, { owner, percent: (old?.percent ?? 0) + share, amount: old ? old.amount !== null && amount !== null ? old.amount + amount : null : amount });
  }
  const wallets = [...owners.values()].sort((a, b) => b.percent - a.percent);
  const sum = (n: number) => wallets.length ? wallets.slice(0, n).reduce((v, h) => v + h.percent, 0) : null;
  const networks = (Array.isArray(rug.insiderNetworks) ? rug.insiderNetworks : []).filter((x: unknown): x is Json => !!x && typeof x === 'object' && !Array.isArray(x)).map((x: Json) => {
    let percent = number(x.totalPercentage ?? x.totalPct ?? x.pct);
    const holding = typeof x.currentHolding === 'string' ? x.currentHolding : typeof x.currentHolding === 'number' && Number.isSafeInteger(x.currentHolding) ? String(x.currentHolding) : '';
    const rawSupply = typeof rug.token?.supply === 'string' ? rug.token.supply : typeof rug.token?.supply === 'number' && Number.isSafeInteger(rug.token.supply) ? String(rug.token.supply) : '';
    if (/^\d+$/.test(holding) && /^\d+$/.test(rawSupply) && BigInt(rawSupply) > BigInt(0)) percent = Number(BigInt(holding) * BigInt(100_000_000) / BigInt(rawSupply)) / 1_000_000;
    return { id: text(x.id), type: text(x.type), wallets: number(x.size ?? (Array.isArray(x.wallets) ? x.wallets.length : Array.isArray(x.accounts) ? x.accounts.length : x.walletCount)), percent };
  });
  const holderCounts = { rugcheck: number(rug.totalHolders), jupiter: number(j.holderCount), goplus: number(evm.holder_count), conflict: false };
  const counts = [holderCounts.rugcheck, holderCounts.jupiter, holderCounts.goplus].filter((x): x is number => x !== null); holderCounts.conflict = new Set(counts).size > 1;
  const supply = chain === 'solana' ? normalized(rug.token?.supply, rug.token?.decimals) : { raw: null, decimals: null, normalized: typeof evm.total_supply === 'string' && /^\d+(?:\.\d+)?$/.test(evm.total_supply) ? evm.total_supply : null };
  const lp = number(pair?.liquidity?.usd); const mcap = base ? number(pair?.marketCap) : null;
  const token = rug.token && typeof rug.token === 'object' && !Array.isArray(rug.token) ? rug.token : null;
  const auditAvailable = chain === 'solana' ? !!token : Object.keys(evm).length > 0;
  const authority = (value: unknown): string | null => {
    if (value === null) return 'none (provider claim)';
    if (typeof value !== 'string') return null;
    try { return normalizeAddress('solana', value); } catch { return null; }
  };
  const mint = chain === 'solana' && token && 'mintAuthority' in token ? authority(token.mintAuthority) : null;
  const freeze = chain === 'solana' && token && 'freezeAuthority' in token ? authority(token.freezeAuthority) : null;
  const marketAudit: Json | undefined = Array.isArray(rug.markets) ? rug.markets.find((m: Json) => m && typeof m === 'object' && same(m.pubkey, pair?.pairAddress, chain)) : undefined;
  const reserves = base ? number(pair?.liquidity?.base) : number(pair?.liquidity?.quote);
  // Dex ID alone does not distinguish Raydium CPMM from DLMM/CLMM. Only explicit pair labels qualify.
  const labels = Array.isArray(pair?.labels) ? pair.labels.map((x: unknown) => String(x).toLowerCase()) : [];
  const compatible = (pair?.dexId === 'pumpswap' || (pair?.dexId === 'raydium' && labels.includes('cpmm'))) && !labels.some((x: string) => /dlmm|clmm|concentrated/.test(x));
  const impact = (amount: number | null): number | null => compatible && reserves !== null && reserves > 0 && amount !== null ? (1 - (reserves / (reserves + amount)) ** 2) * 100 : null;
  const largestNetwork = networks.reduce((a: number | null, n: { percent: number | null }) => n.percent !== null && (a === null || n.percent > a) ? n.percent : a, null);
  // Convert supply only when safely representable; otherwise retain UNKNOWN rather than round raw units.
  const supplyNum = supply.raw && Number.isSafeInteger(Number(supply.raw)) && supply.normalized !== null ? number(supply.normalized) : null;
  const scenarios = { topHolderDropPercent: impact(wallets[0]?.amount ?? null), largestNetworkDropPercent: impact(largestNetwork !== null && supplyNum !== null ? supplyNum * largestNetwork / 100 : null), assumptions: 'Constant product, spot price; ignores fees, arbitrage and routing; current reserves only.' };
  const evmAudit: Record<string, string> = {}; for (const key of ['is_open_source', 'is_mintable', 'is_honeypot', 'is_proxy', 'can_take_back_ownership', 'buy_tax', 'sell_tax']) if (evm[key] !== undefined && evm[key] !== null) evmAudit[key] = String(evm[key]).slice(0, 80);
  const findings: string[] = [];
  if (!auditAvailable) findings.push('Audit unavailable');
  if (!pair) findings.push('Matching market unavailable');
  if (holderCounts.conflict) findings.push('Holder counts disagree');
  if (mint && !mint.startsWith('none')) findings.push('Mint authority present (not proof of fraud)');
  if (freeze && !freeze.startsWith('none')) findings.push('Freeze authority present');
  if (!wallets.length) findings.push('Holder concentration unknown');
  if (!compatible || reserves === null) findings.push('Compatible pool reserves unknown');
  if ((sum(1) ?? 0) >= 20) findings.push('Observed top holder concentration at least 20%');
  if ((largestNetwork ?? 0) >= 20) findings.push('Observed network holdings at least 20%');
  if (largestNetwork !== null && largestNetwork >= 9 && lp !== null && mcap !== null && mcap > 0 && lp / mcap < 0.05) findings.push('Observed network holdings at least 9% with liquidity below 5% of market cap');
  if (evm.is_honeypot === '1') findings.push('GoPlus reports honeypot');
  const risk: CoinAnalysis['risk'] = !auditAvailable ? 'UNKNOWN' : ((sum(1) ?? 0) >= 20 || (largestNetwork ?? 0) >= 20 || (largestNetwork !== null && largestNetwork >= 9 && lp !== null && mcap !== null && mcap > 0 && lp / mcap < 0.05) || evm.is_honeypot === '1' || (!!freeze && !freeze.startsWith('none')) || (!!mint && !mint.startsWith('none'))) ? 'HIGH' : 'MEDIUM';
  const source = (url: string, r: { status: string }, updatedAt: unknown): Source => ({ url, status: r.status, updatedAt: date(updatedAt) });
  const baseReport = { chain, address, fetchedAt: new Date().toISOString(), sources: { dex: source(dexUrl, dex, pair?.updatedAt), audit: source(auditUrl, security, rug.lastUpdated ?? rug.updatedAt), jupiter: source(jupUrl, jup, j.updatedAt) },
    market: { priceUsd: price, marketCap: mcap, fdv: base ? number(pair?.fdv) : null, liquidityUsd: lp, volume24h: number(pair?.volume?.h24), buys24h: number(pair?.txns?.h24?.buys), sells24h: number(pair?.txns?.h24?.sells), pairAddress: text(pair?.pairAddress), dex: text(pair?.dexId), poolCreatedAt: date(pair?.pairCreatedAt), liquidityToMarketCap: lp !== null && mcap !== null && mcap > 0 ? lp / mcap : null },
    supply, holderCounts, holders: { observed: wallets.length, observedPercent: sum(wallets.length), top1: sum(1), top5: sum(5), top10: sum(10), wallets, coverage: 'Observed provider sample only; ranks and totals are not complete. Known pools excluded.' }, networks,
    organic: { score: number(j.organicScore), label: text(j.organicScoreLabel), buyRatio: number(j.stats24h?.buyOrganicVolume) !== null && (number(j.stats24h?.buyVolume) ?? 0) > 0 ? number(j.stats24h?.buyOrganicVolume)! / number(j.stats24h?.buyVolume)! : null, devMints: number(j.audit?.devMints), devMigrations: number(j.audit?.devMigrations) },
    audit: { mintAuthority: mint, freezeAuthority: freeze, token2022: typeof (rug.tokenProgram ?? j.tokenProgram) === 'string' ? (rug.tokenProgram ?? j.tokenProgram) === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' : null, transferFee: (rug.token_extensions as Json | undefined)?.transferFeeConfig || (rug.token_extensions as Json | undefined)?.transfer_fee_config ? 'present (provider claim)' : null, evm: evmAudit, primaryLpLockClaimPercent: number(marketAudit?.lp?.lpLockedPct) }, scenarios, risk, findings,
    mapUrl: `https://v2.bubblemaps.io/map?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}` };
  return { ...baseReport, tradeGuardrail: evaluateTradeGuardrails(baseReport) };
}

/** Deterministic hard safety gate for future execution modules; AI cannot override BLOCKED status. */
export function evaluateTradeGuardrails(r: Omit<CoinAnalysis, 'tradeGuardrail'>): TradeGuardrail {
  const blockedReasons: string[] = [];
  const warnings: string[] = [];
  if (r.findings.includes('Audit unavailable')) blockedReasons.push('audit_unavailable');
  if (r.sources.audit?.status !== 'ok') blockedReasons.push('audit_source_unavailable');
  if (!Number.isFinite(Date.parse(r.fetchedAt)) || Date.now() - Date.parse(r.fetchedAt) > 60_000 || Date.parse(r.fetchedAt) > Date.now() + 5000) blockedReasons.push('stale_analysis');
  const auditTime = r.sources.audit?.updatedAt;
  if (auditTime === null || auditTime === undefined) warnings.push('audit_time_unknown');
  else if (!Number.isFinite(Date.parse(auditTime)) || Date.now() - Date.parse(auditTime) > 300_000 || Date.parse(auditTime) > Date.now() + 5000) blockedReasons.push('stale_audit_evidence');
  if (r.holderCounts.conflict) blockedReasons.push('holder_count_conflict');
  if (r.holders.top1 === null || !Number.isFinite(r.holders.top1) || r.holders.top1 < 0 || r.holders.top1 > 100) blockedReasons.push('holder_concentration_unknown');
  if (r.chain === 'solana') {
    if (r.audit.mintAuthority === null || r.audit.freezeAuthority === null) blockedReasons.push('authority_status_unknown');
    if (r.audit.token2022 === null) blockedReasons.push('token_program_unknown');
  } else {
    if (!['0', '1'].includes(r.audit.evm.is_honeypot ?? '') || !['0', '1'].includes(r.audit.evm.is_mintable ?? '')) blockedReasons.push('evm_audit_incomplete');
    if (r.audit.evm.is_mintable === '1') warnings.push('mint_authority_active');
    if (r.audit.evm.is_proxy !== '0') warnings.push('proxy_status_unsafe_or_unknown');
    if (r.audit.evm.is_open_source !== '1') warnings.push('source_unverified');
    if (r.audit.evm.can_take_back_ownership !== '0') warnings.push('ownership_recovery_unsafe_or_unknown');
  }
  if (r.findings.includes('Matching market unavailable') || r.market.priceUsd === null || !Number.isFinite(r.market.priceUsd) || r.market.priceUsd <= 0) blockedReasons.push('market_unavailable');
  if (r.audit.evm.is_honeypot === '1') blockedReasons.push('honeypot_detected');
  if (r.audit.freezeAuthority && r.audit.freezeAuthority !== 'none (provider claim)') blockedReasons.push('freeze_authority_active');
  if (r.market.liquidityUsd === null || !Number.isFinite(r.market.liquidityUsd) || r.market.liquidityUsd < 10_000) blockedReasons.push('liquidity_below_10k_usd');
  const tax = (value: string | undefined) => value !== undefined && /^(?:0|1|0\.\d+)$/.test(value) ? Number(value) : null;
  const buyTax = tax(r.audit.evm.buy_tax);
  const sellTax = tax(r.audit.evm.sell_tax);
  if (r.chain !== 'solana' && (buyTax === null || sellTax === null)) blockedReasons.push('evm_tax_unknown');
  if ((buyTax !== null && buyTax > 0.05) || (sellTax !== null && sellTax > 0.05)) blockedReasons.push('evm_tax_above_5pct');
  if (r.audit.mintAuthority && r.audit.mintAuthority !== 'none (provider claim)') warnings.push('mint_authority_active');
  if (r.audit.transferFee !== null) warnings.push('token2022_transfer_fee');
  if ((r.holders.top1 ?? 0) >= 20) warnings.push('top1_holder_ge_20pct');
  if (r.networks.some(n => (n.percent ?? 0) >= 20)) warnings.push('network_cluster_ge_20pct');
  if (r.market.liquidityToMarketCap !== null && r.market.liquidityToMarketCap < 0.05) warnings.push('thin_lp_mcap_ratio');
  const status: TradeGuardrail['status'] = blockedReasons.length ? 'BLOCKED' : warnings.length ? 'WARN' : 'PASS';
  return { status, blockedReasons, warnings };
}
export async function analyzeCoin(address: string, chain = 'solana', options: { fresh?: boolean } = {}): Promise<CoinAnalysis> {
  chain = normalizeChain(chain); address = normalizeAddress(chain, address);
  if (chain !== 'solana' && !chainIds[chain]) throw new Error('Unsupported analysis chain');
  if (options.fresh) return collect(address, chain, true);
  const key = `${chain}:${address}`; const hit = cache.get(key); if (hit && hit.expires > Date.now()) return hit.value;
  const running = inflight.get(key); if (running) return running;
  const pending = collect(address, chain).then(value => { if (cache.size >= 200) cache.delete(cache.keys().next().value!); cache.set(key, { value, expires: Date.now() + 60_000 }); return value; }).finally(() => inflight.delete(key));
  inflight.set(key, pending); return pending;
}
export function formatCoinAnalysis(r: CoinAnalysis): string {
  const n = (v: number | null) => v === null || !Number.isFinite(v) ? 'UNKNOWN' : String(Number(v.toPrecision(6)));
  const guardrailDetail = [...r.tradeGuardrail.blockedReasons, ...r.tradeGuardrail.warnings].join(', ') || 'lolos syarat dasar';
  const lines = [`<b>Analisis ${escapeHtml(r.chain)}</b> <code>${escapeHtml(r.address)}</code>`, `Risiko: <b>${r.risk}</b> (bukan jaminan keamanan) | Guardrail: <b>${r.tradeGuardrail.status}</b> (${escapeHtml(guardrailDetail)})`, `Harga USD: ${n(r.market.priceUsd)} | MCAP: ${n(r.market.marketCap)} | FDV: ${n(r.market.fdv)}`, `Likuiditas USD: ${n(r.market.liquidityUsd)} | LP/MCAP: ${n(r.market.liquidityToMarketCap)} | Volume 24h: ${n(r.market.volume24h)}`, `Transaksi 24h buy/sell: ${n(r.market.buys24h)}/${n(r.market.sells24h)} | Pool: ${escapeHtml(r.market.dex ?? 'UNKNOWN')}`, `Supply raw: ${escapeHtml(r.supply.raw ?? 'UNKNOWN')} | decimals: ${n(r.supply.decimals)} | normalized: ${escapeHtml(r.supply.normalized ?? 'UNKNOWN')}`, `Holder count Rugcheck/Jupiter/GoPlus: ${n(r.holderCounts.rugcheck)}/${n(r.holderCounts.jupiter)}/${n(r.holderCounts.goplus)}${r.holderCounts.conflict ? ' (berbeda)' : ''}`, `Non-pool sampel ${r.holders.observed}: top 1/5/10 ${n(r.holders.top1)}% / ${n(r.holders.top5)}% / ${n(r.holders.top10)}%; cakupan teramati ${n(r.holders.observedPercent)}%. Bukan distribusi lengkap.`, `Network holdings saat ini: ${r.networks.length ? r.networks.slice(0, 5).map(x => `${n(x.wallets)} wallet, ${n(x.percent)}%`).join('; ') : 'UNKNOWN'}; network dapat tumpang tindih.`, `Organic: ${n(r.organic.score)} (${escapeHtml(r.organic.label ?? 'UNKNOWN')}) | mint: ${escapeHtml(r.audit.mintAuthority ?? 'UNKNOWN')} | freeze: ${escapeHtml(r.audit.freezeAuthority ?? 'UNKNOWN')} | Token-2022: ${r.audit.token2022 === null ? 'UNKNOWN' : r.audit.token2022}`, `LP lock pool utama: ${n(r.audit.primaryLpLockClaimPercent)}% (klaim provider, bukan bukti)`, `Simulasi penurunan top holder/network: ${n(r.scenarios.topHolderDropPercent)}% / ${n(r.scenarios.largestNetworkDropPercent)}%. ${escapeHtml(r.scenarios.assumptions)}`, `Temuan: ${escapeHtml(r.findings.join('; ') || 'Tidak ada temuan deterministik; data dapat tidak lengkap')}`, `Bubblemaps: <a href="${escapeHtml(r.mapUrl)}">buka peta</a> (data peta aktual tidak tersedia)`, `Sumber: ${Object.entries(r.sources).map(([k, v]) => `${escapeHtml(k)} ${escapeHtml(v.status)} (${escapeHtml(v.updatedAt ?? 'waktu provider UNKNOWN')})`).join('; ')}`, `Diambil: ${escapeHtml(r.fetchedAt)}`];
  if (r.chain !== 'solana') lines.splice(10, 0, `GoPlus (klaim provider): ${escapeHtml(Object.entries(r.audit.evm).map(([key, value]) => `${key}=${value}`).join(', ') || 'UNKNOWN')}`);
  else lines.splice(10, 0, `Transfer fee: ${escapeHtml(r.audit.transferFee ?? 'UNKNOWN')} | organic buy ratio: ${n(r.organic.buyRatio)} | dev mints/migrations: ${n(r.organic.devMints)}/${n(r.organic.devMigrations)}`);
  let result = '';
  for (const line of lines) {
    if (result.length + line.length + 1 > 3400) break;
    result += (result ? '\n' : '') + line;
  }
  return result;
}
