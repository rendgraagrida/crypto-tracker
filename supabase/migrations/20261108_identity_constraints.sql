-- After 20261107_whitelist_chain.sql. Run a duplicate preflight on the chosen database first.
-- CREATE UNIQUE INDEX deliberately fails on existing ambiguous aliases; never auto-delete user rows.
begin;
create or replace function public.bot_canonical_chain(chain text) returns text
language sql immutable strict parallel safe set search_path=public as $$
 select case lower(btrim(chain))
 when 'sol' then 'solana' when 'eth' then 'ethereum' when 'base chain' then 'base'
 when 'binance' then 'bsc' when 'bnb' then 'bsc' when 'matic' then 'polygon'
 when 'polygon_pos' then 'polygon' when 'arbitrum_one' then 'arbitrum'
 when 'op' then 'optimism' when 'avax' then 'avalanche'
 when 'rh' then 'robinhood' when 'robinhood chain' then 'robinhood'
 else lower(btrim(chain)) end;
$$;
create or replace function public.bot_canonical_address(chain text,address text) returns text
language sql immutable strict parallel safe set search_path=public as $$
 select case when public.bot_canonical_chain(chain)='solana' then btrim(address) else lower(btrim(address)) end;
$$;
create unique index if not exists bot_watchlist_identity on public.watchlist
 (public.bot_canonical_chain(chain_network),public.bot_canonical_address(chain_network,wallet_address)) where chain_network is not null;
create unique index if not exists bot_tracked_identity on public.tracked_coins
 (public.bot_canonical_chain(chain_network),public.bot_canonical_address(chain_network,contract_address)) where chain_network is not null;
create unique index if not exists bot_blacklist_identity on public.blacklist_tokens
 (public.bot_canonical_chain(chain_network),public.bot_canonical_address(chain_network,contract_address)) where chain_network is not null;
create unique index if not exists bot_whitelist_identity on public.whitelist_tokens
 (public.bot_canonical_chain(chain_network),public.bot_canonical_address(chain_network,contract_address)) where chain_network is not null;
revoke execute on function public.bot_canonical_chain(text) from public,anon,authenticated;
revoke execute on function public.bot_canonical_address(text,text) from public,anon,authenticated;
grant execute on function public.bot_canonical_chain(text) to service_role;
grant execute on function public.bot_canonical_address(text,text) to service_role;
commit;
