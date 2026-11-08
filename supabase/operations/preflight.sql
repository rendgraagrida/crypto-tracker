-- After base schema + whitelist migration, before identity unique indexes.
-- Read-only; ambiguous identities stop the rollout without exposing addresses.
begin read only;
do $$
declare duplicates bigint;
begin
  with assets as (
    select 'watchlist' t, chain_network c, wallet_address a from public.watchlist
    union all select 'tracked_coins', chain_network, contract_address from public.tracked_coins
    union all select 'blacklist_tokens', chain_network, contract_address from public.blacklist_tokens
    union all select 'whitelist_tokens', chain_network, contract_address from public.whitelist_tokens
  ), normalized as (
    select t, case lower(btrim(c))
      when 'sol' then 'solana' when 'eth' then 'ethereum' when 'base chain' then 'base'
      when 'binance' then 'bsc' when 'bnb' then 'bsc' when 'matic' then 'polygon'
      when 'polygon_pos' then 'polygon' when 'arbitrum_one' then 'arbitrum'
      when 'op' then 'optimism' when 'avax' then 'avalanche'
      when 'rh' then 'robinhood' when 'robinhood chain' then 'robinhood'
      else lower(btrim(c)) end chain, a
    from assets where c is not null
  )
  select count(*) into duplicates from (
    select t,chain,case when chain='solana' then btrim(a) else lower(btrim(a)) end address
    from normalized group by 1,2,3 having count(*)>1
  ) ambiguous;
  if duplicates>0 then
    raise exception 'Identity preflight rejected: % ambiguous groups; review locally, no rows were deleted',duplicates;
  end if;
end $$;
select 'Identity preflight passed; no data changed' as result;
commit;
