import { PublicKey } from '@solana/web3.js';
import { normalizeChain } from './auth.ts';
import { readBoundedJson } from './bounded-json.ts';

const urls: Record<string, () => string | undefined> = {
  ethereum: () => process.env.ALCHEMY_ETH_URL,
  base: () => process.env.ALCHEMY_BASE_URL,
  bsc: () => process.env.ALCHEMY_BSC_URL,
  robinhood: () => process.env.ALCHEMY_ROBINHOOD_URL,
  polygon: () => process.env.ALCHEMY_POLYGON_URL,
  arbitrum: () => process.env.ALCHEMY_ARBITRUM_URL,
  optimism: () => process.env.ALCHEMY_OPTIMISM_URL,
  avalanche: () => process.env.ALCHEMY_AVALANCHE_URL,
  solana: () => process.env.ALCHEMY_SOL_URL || 'https://api.mainnet-beta.solana.com',
};

type Wallet = { wallet_address: string; chain_network: string; [key: string]: unknown };
export async function fetchWalletBalancesLive<T extends Wallet>(wallets: T[]): Promise<Array<T & { balance: string; balanceDisplay: string; nativeBalance: number | null }>> {
  const amounts: Array<number | null> = wallets.map(() => null);
  const groups = new Map<string, number[]>();
  wallets.forEach((wallet, index) => {
    try { const chain = normalizeChain(wallet.chain_network); const group = groups.get(chain) ?? []; group.push(index); groups.set(chain, group); } catch {}
  });
  await Promise.all([...groups].map(async ([chain, indices]) => {
    const url = urls[chain]?.();
    if (!url) return;
    const valid = indices.filter(index => {
      try { if (chain === 'solana') new PublicKey(wallets[index].wallet_address); else if (!/^0x[0-9a-fA-F]{40}$/.test(wallets[index].wallet_address)) return false; return true; } catch { return false; }
    });
    for (let offset = 0; offset < valid.length; offset += 100) {
      const chunk = valid.slice(offset, offset + 100);
      const body = chain === 'solana'
        ? { jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [chunk.map(i => wallets[i].wallet_address), { encoding: 'base64', commitment: 'confirmed' }] }
        : chunk.map((i, id) => ({ jsonrpc: '2.0', id, method: 'eth_getBalance', params: [wallets[i].wallet_address, 'latest'] }));
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
        if (!response.ok) continue;
        const data = await readBoundedJson(response.body, 1_000_000, 8000) as { result?: { value?: Array<{ lamports?: number } | null> } } | Array<{ id: number; result?: string }>;
        if (chain === 'solana' && !Array.isArray(data) && Array.isArray(data.result?.value)) {
          data.result.value.forEach((account: { lamports?: number } | null, id: number) => { if (account && typeof account.lamports === 'number' && Number.isFinite(account.lamports)) amounts[chunk[id]] = account.lamports / 1e9; });
        } else if (Array.isArray(data)) {
          for (const item of data) if (Number.isInteger(item.id) && chunk[item.id] !== undefined && typeof item.result === 'string' && /^0x[0-9a-f]+$/i.test(item.result)) {
            const value = Number(BigInt(item.result)) / 1e18;
            if (Number.isFinite(value)) amounts[chunk[item.id]] = value;
          }
        }
      } catch { /* Leave unavailable balances unknown. */ }
    }
  }));
  return wallets.map((wallet, index) => {
    const nativeBalance = amounts[index];
    const balanceDisplay = nativeBalance === null ? 'N/A' : nativeBalance.toFixed(4);
    return { ...wallet, balance: balanceDisplay, balanceDisplay, nativeBalance };
  });
}
