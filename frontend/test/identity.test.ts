import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deleteChainIdentities, resolveStoredIdentity } from '../app/lib/identity.ts';

const address = '0x1234567890abcdef1234567890abcdef12345678';
function database(rows: Array<Record<string, unknown>>) {
  return { from: () => ({ select: () => ({ limit: async () => ({ data: rows, error: null, count: rows.length }) }) }) } as unknown as SupabaseClient;
}

test('identity resolves legacy chain aliases and checksum case without crossing chains', async () => {
  const rows = [
    { contract_address: address.toUpperCase().replace('0X', '0x'), chain_network: 'Base Chain' },
    { contract_address: address, chain_network: 'Ethereum' },
    { contract_address: address, chain_network: null },
  ];
  assert.deepEqual(await resolveStoredIdentity(database(rows), 'tracked_coins', 'contract_address', 'base', address), { address: rows[0].contract_address, chain: 'Base Chain' });
  assert.equal(await resolveStoredIdentity(database(rows), 'tracked_coins', 'contract_address', 'bsc', address), null);
});

test('identity rejects ambiguous duplicate aliases and preserves Solana case', async () => {
  const duplicates = [{ wallet_address: address, chain_network: 'base' }, { wallet_address: address, chain_network: 'Base Chain' }];
  await assert.rejects(resolveStoredIdentity(database(duplicates), 'watchlist', 'wallet_address', 'base', address), /Ambiguous/);
  const sol = 'So11111111111111111111111111111111111111112';
  assert.equal(await resolveStoredIdentity(database([{ contract_address: sol.toLowerCase(), chain_network: 'solana' }]), 'tracked_coins', 'contract_address', 'solana', sol), null);
});

test('bulk deletion resolves aliases without deleting other or unassigned chains', async () => {
  const rows = [
    { contract_address: address, chain_network: 'Base Chain' },
    { contract_address: '0x0000000000000000000000000000000000000002', chain_network: 'base' },
    { contract_address: address, chain_network: 'ethereum' },
    { contract_address: address, chain_network: null },
  ];
  const deleted: string[] = [];
  const db = { from: () => ({
    select: () => ({ limit: async () => ({ data: rows, error: null, count: rows.length }) }),
    delete: () => ({ eq: (_column: string, addr: string) => ({ eq: (_chainColumn: string, chain: string) => ({ select: async () => { deleted.push(`${chain}:${addr}`); return { data: [{ contract_address: addr }], error: null }; } }) }) }),
  }) } as unknown as SupabaseClient;
  assert.deepEqual(await deleteChainIdentities(db, 'tracked_coins', 'contract_address', 'base'), { deleted: 2, error: null });
  assert.deepEqual(deleted, [`Base Chain:${address}`, 'base:0x0000000000000000000000000000000000000002']);
});

test('bulk deletion detects ambiguous legacy duplicates before deleting anything', async () => {
  const rows = [{ contract_address: address, chain_network: 'Base Chain' }, { contract_address: address, chain_network: 'base' }];
  await assert.rejects(deleteChainIdentities(database(rows), 'tracked_coins', 'contract_address', 'base'), /Ambiguous/);
});
