import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeAddress, normalizeChain } from './auth.ts';

type Table = 'watchlist' | 'tracked_coins' | 'blacklist_tokens' | 'whitelist_tokens';
type AddressColumn = 'wallet_address' | 'contract_address';
type Identity = { address: string; chain: string };

/** Resolve exactly one stored row without guessing a chain for legacy data. */
export async function resolveStoredIdentity(db: SupabaseClient, table: Table, column: AddressColumn, chain: string, address: string): Promise<Identity | null> {
  const canonicalChain = normalizeChain(chain);
  const canonicalAddress = normalizeAddress(canonicalChain, address);
  const { data, error, count } = await db.from(table).select(`${column},chain_network`, { count: 'exact' }).limit(1001);
  if (error || count === null) throw new Error('Unable to read stored identities');
  if (!data || count > 1000) throw new Error('Too many stored identities to resolve safely');
  const matches: Identity[] = [];
  for (const item of data as unknown as Array<Record<string, unknown>>) {
    if (typeof item.chain_network !== 'string' || typeof item[column] !== 'string') continue;
    try {
      if (normalizeChain(item.chain_network) === canonicalChain && normalizeAddress(canonicalChain, item[column] as string) === canonicalAddress) matches.push({ address: item[column] as string, chain: item.chain_network });
    } catch { /* Unassigned or invalid legacy rows are not inferred. */ }
  }
  if (matches.length > 1) throw new Error('Ambiguous stored identity; resolve duplicate rows first');
  return matches[0] ?? null;
}

/** Delete each uniquely resolved identity on a canonical chain; partial failures are reported. */
export async function deleteChainIdentities(db: SupabaseClient, table: Table, column: AddressColumn, chain: string): Promise<{ deleted: number; error: string | null }> {
  const canonicalChain = normalizeChain(chain);
  const { data, error, count } = await db.from(table).select(`${column},chain_network`, { count: 'exact' }).limit(1001);
  if (error || count === null || !data) throw new Error('Unable to read stored identities');
  if (count > 1000) throw new Error('Too many stored identities to delete safely');
  const targets: Identity[] = [];
  const seen = new Set<string>();
  for (const item of data as unknown as Array<Record<string, unknown>>) {
    if (typeof item.chain_network !== 'string') continue;
    let rowChain: string;
    try { rowChain = normalizeChain(item.chain_network); } catch { continue; }
    if (rowChain !== canonicalChain) continue;
    const address = item[column];
    if (typeof address !== 'string') throw new Error('Invalid stored address on selected chain');
    let normalized: string;
    try { normalized = normalizeAddress(rowChain, address); } catch { throw new Error('Invalid stored address on selected chain'); }
    if (seen.has(normalized)) throw new Error('Ambiguous stored identity; resolve duplicate rows first');
    seen.add(normalized);
    targets.push({ address, chain: item.chain_network });
  }
  let deleted = 0;
  for (const target of targets) {
    const result = await db.from(table).delete().eq(column, target.address).eq('chain_network', target.chain).select(column);
    if (result.error || result.data?.length !== 1) return { deleted, error: `Deletion incomplete after ${deleted} confirmed rows; refresh and retry` };
    deleted++;
  }
  return { deleted, error: null };
}
