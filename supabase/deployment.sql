-- Generated from canonical SQL sources. Review for an isolated database; no remote operation was performed.
-- BEGIN migrations/20261106_base_schema.sql

begin;
do $$
declare
  spec record;
  required_column text;
begin
  for spec in select * from (values
    ('watchlist', 'wallet_address text not null, chain_network text, label text, is_primary boolean not null default false, created_at timestamptz not null default now()', array['wallet_address','chain_network','label','is_primary','created_at']),
    ('tracked_coins', 'contract_address text not null, chain_network text, label text, is_primary boolean not null default false, created_at timestamptz not null default now()', array['contract_address','chain_network','label','is_primary','created_at']),
    ('blacklist_tokens', 'contract_address text not null, chain_network text, label text, created_at timestamptz not null default now()', array['contract_address','chain_network','label','created_at']),
    ('whitelist_tokens', 'contract_address text not null, label text, created_at timestamptz not null default now()', array['contract_address','label']),
    ('app_settings', 'key text primary key, value text, updated_at timestamptz', array['key','value','updated_at'])
  ) as tables(name, definition, columns)
  loop
    if to_regclass(format('public.%I', spec.name)) is null then
      execute format('create table if not exists public.%I (%s)', spec.name, spec.definition);
    end if;
    execute format('alter table public.%I enable row level security', spec.name);
    execute format('revoke all on public.%I from public, anon, authenticated', spec.name);
    execute format('grant all on public.%I to service_role', spec.name);
    foreach required_column in array spec.columns loop
      if not exists (select 1 from pg_attribute where attrelid=to_regclass(format('public.%I', spec.name))
                     and attname=required_column and attnum>0 and not attisdropped) then
        raise exception 'Existing public.% lacks required column %', spec.name, required_column;
      end if;
    end loop;
  end loop;
end $$;
commit;

-- END migrations/20261106_base_schema.sql

-- BEGIN migrations/20261107_bot_runtime.sql
-- Apply deliberately to an isolated/staging Supabase project first. Product data is not rewritten.
begin;
create table if not exists public.bot_jobs (
  id text primary key, kind text not null check(kind in ('update','scan','send','enrich')), payload jsonb not null,
  status text not null default 'pending' check(status in ('pending','running','done','failed')),
  attempts integer not null default 0, run_after timestamptz not null default now(),
  lease_until timestamptz, created_at timestamptz not null default now()
);
create index if not exists bot_jobs_due on public.bot_jobs(status,run_after);
create table if not exists public.bot_state(key text primary key,value jsonb not null);
create table if not exists public.bot_confirmations(
  token text primary key,user_id text not null,chat_id text not null,command text not null,
  expires_at timestamptz not null,claimed_update_id bigint
);
alter table public.bot_confirmations add column if not exists claimed_update_id bigint;
alter table public.bot_jobs enable row level security;
alter table public.bot_state enable row level security;
alter table public.bot_confirmations enable row level security;
revoke all on public.bot_jobs,public.bot_state,public.bot_confirmations from anon,authenticated;
grant all on public.bot_jobs,public.bot_state,public.bot_confirmations to service_role;

-- Serialize claims globally: one bot consumer executes side effects, not one per process.
create or replace function public.bot_claim_job()
returns setof public.bot_jobs language plpgsql security invoker set search_path=public as $$
begin
  perform pg_advisory_xact_lock(74111907);
  update public.bot_jobs set status='failed',lease_until=null
    where status='running' and lease_until<=now() and attempts>=4;
  if exists(select 1 from public.bot_jobs where status='running' and lease_until>now()) then return; end if;
  return query update public.bot_jobs j set status='running',attempts=j.attempts+1,lease_until=now()+interval '180 seconds'
    where j.id=(select id from public.bot_jobs where attempts<4 and
      ((status='pending' and run_after<=now()) or (status='running' and lease_until<=now()))
      order by run_after,created_at for update skip locked limit 1)
    returning j.*;
end $$;

create or replace function public.bot_has_lease(p_id text,p_attempt integer)
returns boolean language sql security invoker set search_path=public as $$
 select exists(select 1 from public.bot_jobs where id=p_id and attempts=p_attempt and status='running' and lease_until>clock_timestamp());
$$;
create or replace function public.bot_renew_job(p_id text,p_attempt integer)
returns boolean language plpgsql security invoker set search_path=public as $$
begin
 perform pg_advisory_xact_lock(74111907);
 update public.bot_jobs set lease_until=clock_timestamp()+interval '180 seconds'
 where id=p_id and attempts=p_attempt and status='running' and lease_until>clock_timestamp();
 return found;
end $$;

create or replace function public.bot_write_state(p_key text,p_value jsonb,p_id text,p_attempt integer)
returns void language plpgsql security invoker set search_path=public as $$
begin
 perform pg_advisory_xact_lock(74111907);
 if p_key like 'cursor:%' or p_key like 'backfill:%' or p_key like 'indicator:%' then
   if not public.bot_has_lease(p_id,p_attempt) then raise exception 'Lease lost'; end if;
 end if;
 insert into public.bot_state(key,value) values(p_key,coalesce(p_value,'null'::jsonb)) on conflict(key) do update set value=excluded.value;
end $$;

-- The confirmation becomes a durable intent bound to exactly one Telegram update.
-- A retry of that same update can resume; a different update cannot reuse the token.
drop function if exists public.bot_take_confirmation(text,text,text);
create or replace function public.bot_take_confirmation(p_token text,p_user text,p_chat text,p_update bigint)
returns setof public.bot_confirmations language sql security invoker set search_path=public as $$
 update public.bot_confirmations set claimed_update_id=p_update
 where token=p_token and user_id=p_user and chat_id=p_chat and
 ((claimed_update_id is null and expires_at>now()) or claimed_update_id=p_update)
 returning *;
$$;
revoke execute on function public.bot_claim_job() from public,anon,authenticated;
revoke execute on function public.bot_has_lease(text,integer) from public,anon,authenticated;
revoke execute on function public.bot_renew_job(text,integer) from public,anon,authenticated;
revoke execute on function public.bot_write_state(text,jsonb,text,integer) from public,anon,authenticated;
revoke execute on function public.bot_take_confirmation(text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.bot_claim_job() to service_role;
grant execute on function public.bot_has_lease(text,integer) to service_role;
grant execute on function public.bot_renew_job(text,integer) to service_role;
grant execute on function public.bot_write_state(text,jsonb,text,integer) to service_role;
grant execute on function public.bot_take_confirmation(text,text,text,bigint) to service_role;
commit;

-- END migrations/20261107_bot_runtime.sql

-- BEGIN migrations/20261107_whitelist_chain.sql
-- Run deliberately against a non-production environment first. Existing rows remain unassigned.
begin;
alter table public.whitelist_tokens add column if not exists chain_network text;
commit;

-- END migrations/20261107_whitelist_chain.sql

-- BEGIN operations/preflight.sql
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

-- END operations/preflight.sql

-- BEGIN migrations/20261108_identity_constraints.sql
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

-- END migrations/20261108_identity_constraints.sql

-- BEGIN migrations/20261109_paper_trading.sql
-- Apply only to an intentionally selected isolated database after bot runtime migration.
begin;
alter table public.bot_jobs drop constraint if exists bot_jobs_kind_check;
alter table public.bot_jobs add constraint bot_jobs_kind_check check(kind in ('update','scan','send','enrich','paper','maintenance'));
create table if not exists public.paper_trades (
  signal_id text primary key,
  user_id text not null,
  chat_id text not null,
  entry_at timestamptz not null,
  trade jsonb not null
);
create index if not exists paper_trades_entry on public.paper_trades(entry_at);
create index if not exists paper_trades_actor on public.paper_trades(user_id,chat_id,entry_at desc);
alter table public.paper_trades enable row level security;
revoke all on public.paper_trades from public,anon,authenticated;
grant select on public.paper_trades to service_role;
-- Writes are restricted to fenced functions; owner rights are used only after lease validation.
create or replace function public.paper_open(p_id text,p_attempt integer,p_trade jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
  perform pg_advisory_xact_lock(74111907);
  if not public.bot_has_lease(p_id,p_attempt) then raise exception 'Lease lost'; end if;
  if coalesce(p_trade->>'signalId','')='' or coalesce(p_trade#>>'{actor,userId}','')='' or coalesce(p_trade#>>'{actor,chatId}','')='' then raise exception 'Invalid paper identity'; end if;
  insert into public.paper_trades(signal_id,user_id,chat_id,entry_at,trade)
    values(p_trade->>'signalId',p_trade#>>'{actor,userId}',p_trade#>>'{actor,chatId}',(p_trade->>'entryAt')::timestamptz,p_trade)
    on conflict(signal_id) do nothing;
  select trade into result from public.paper_trades where signal_id=p_trade->>'signalId' and user_id=p_trade#>>'{actor,userId}' and chat_id=p_trade#>>'{actor,chatId}';
  if result is null then raise exception 'Paper signal belongs to another actor'; end if;
  return result;
end $$;
create or replace function public.paper_due(p_now timestamptz,p_limit integer)
returns setof jsonb language sql security invoker set search_path=public as $$
 select trade from public.paper_trades
 where (entry_at + interval '1 hour' <= p_now and not (trade->'marks' ? '1h'))
    or (entry_at + interval '6 hours' <= p_now and not (trade->'marks' ? '6h'))
    or (entry_at + interval '24 hours' <= p_now and not (trade->'marks' ? '24h'))
 order by entry_at,signal_id limit greatest(1,least(p_limit,500));
$$;
create or replace function public.paper_settle(p_id text,p_attempt integer,p_signal_id text,p_mark jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare h text := p_mark->>'horizon';
begin
  perform pg_advisory_xact_lock(74111907);
  if not public.bot_has_lease(p_id,p_attempt) then raise exception 'Lease lost'; end if;
  if h not in ('1h','6h','24h') or h is null then raise exception 'Invalid horizon'; end if;
  update public.paper_trades set trade=jsonb_set(trade,array['marks',h],p_mark,true)
    where signal_id=p_signal_id and not (trade->'marks' ? h);
  if not found and not exists(select 1 from public.paper_trades where signal_id=p_signal_id and trade->'marks' ? h) then raise exception 'Paper trade missing'; end if;
end $$;
revoke execute on function public.paper_open(text,integer,jsonb) from public,anon,authenticated;
revoke execute on function public.paper_due(timestamptz,integer) from public,anon,authenticated;
revoke execute on function public.paper_settle(text,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.paper_open(text,integer,jsonb) to service_role;
grant execute on function public.paper_due(timestamptz,integer) to service_role;
grant execute on function public.paper_settle(text,integer,text,jsonb) to service_role;
commit;

-- END migrations/20261109_paper_trading.sql

-- BEGIN migrations/20261110_trade_execution.sql
-- Local deliverable only. Review/apply deliberately to an isolated database after 20261107_bot_runtime.sql.
begin;
create table if not exists public.trade_orders (
 id text primary key, user_id text not null, chat_id text not null,
 quote jsonb not null, quote_hash text not null, notional_usd numeric(28,6) not null check(notional_usd>0),
 mode text not null check(mode in ('manual','auto')),
 status text not null default 'quoted' check(status in ('quoted','confirmed','executing','signed','submitted','confirmed_onchain','failed','expired','unknown')),
 expires_at timestamptz not null, confirmed_update_id bigint,
 execution_token uuid, lease_until timestamptz, risk_reserved_usd numeric(28,6) not null default 0,
 tx_hash text, signed_payload text, last_error text, created_at timestamptz not null default clock_timestamp(),
 check((signed_payload is null)=(tx_hash is null))
);
create index if not exists trade_orders_due on public.trade_orders(status,created_at);
create table if not exists public.trade_risk (
 id boolean primary key default true check(id), killed boolean not null default false,
 reason text, used_usd numeric(28,6) not null default 0 check(used_usd>=0), updated_at timestamptz not null default clock_timestamp()
);
insert into public.trade_risk(id) values(true) on conflict do nothing;
create table if not exists public.trade_daily_risk(day date primary key, used_usd numeric(28,6) not null default 0 check(used_usd>=0));
alter table public.trade_orders enable row level security;
alter table public.trade_risk enable row level security;
alter table public.trade_daily_risk enable row level security;
revoke all on public.trade_orders,public.trade_risk,public.trade_daily_risk from public,anon,authenticated;
grant all on public.trade_orders,public.trade_risk,public.trade_daily_risk to service_role;

create or replace function public.trade_create(p_id text,p_user text,p_chat text,p_quote jsonb,p_hash text,p_notional numeric,p_mode text,p_job text,p_attempt integer)
returns void language plpgsql security invoker set search_path=public as $$
begin
 perform pg_advisory_xact_lock(74111907);
 if not public.bot_has_lease(p_job,p_attempt) then raise exception 'Lease lost'; end if;
 if p_mode not in ('manual','auto') or p_notional<=0 or p_id!~'^[a-f0-9]{32}$' or p_hash!~'^[a-f0-9]{64}$' then raise exception 'Invalid order'; end if;
 if (p_quote->>'expiresAt')::timestamptz<=clock_timestamp() or (p_quote->>'expiresAt')::timestamptz>clock_timestamp()+interval '31 seconds' then raise exception 'Invalid quote expiry'; end if;
 insert into public.trade_orders(id,user_id,chat_id,quote,quote_hash,notional_usd,mode,expires_at)
 values(p_id,p_user,p_chat,p_quote,p_hash,p_notional,p_mode,(p_quote->>'expiresAt')::timestamptz) on conflict(id) do nothing;
 if not exists(select 1 from public.trade_orders where id=p_id and user_id=p_user and chat_id=p_chat and quote_hash=p_hash and notional_usd=p_notional and mode=p_mode) then raise exception 'Order identity conflict'; end if;
end $$;

create or replace function public.trade_confirm(p_id text,p_user text,p_chat text,p_update bigint,p_job text,p_attempt integer)
returns boolean language plpgsql security invoker set search_path=public as $$
declare o public.trade_orders;
begin
 perform pg_advisory_xact_lock(74111907);
 if not public.bot_has_lease(p_job,p_attempt) then raise exception 'Lease lost'; end if;
 select * into o from public.trade_orders where id=p_id and user_id=p_user and chat_id=p_chat for update;
 if not found then return false; end if;
 if o.confirmed_update_id=p_update then return true; end if;
 if o.status<>'quoted' or o.confirmed_update_id is not null or o.expires_at<=clock_timestamp() then return false; end if;
 update public.trade_orders set status='confirmed',confirmed_update_id=p_update where id=p_id;
 return true;
end $$;

create or replace function public.trade_set_kill(p_killed boolean,p_reason text,p_job text,p_attempt integer)
returns void language plpgsql security invoker set search_path=public as $$
begin
 perform pg_advisory_xact_lock(74111907);
 if not public.bot_has_lease(p_job,p_attempt) then raise exception 'Lease lost'; end if;
 perform pg_advisory_xact_lock(74111908);
 -- Reset only unlatches the switch: it never erases reservations or supplies a fresh risk budget.
 update public.trade_risk set killed=p_killed,reason=left(p_reason,200),updated_at=clock_timestamp() where id=true;
end $$;

drop function if exists public.trade_claim();
create or replace function public.trade_claim(p_signed_only boolean default false)
returns setof public.trade_orders language plpgsql security invoker set search_path=public as $$
declare chosen text;
begin
 perform pg_advisory_xact_lock(74111908);
 if exists(select 1 from public.trade_orders where lease_until>clock_timestamp()) then return; end if;
 select id into chosen from public.trade_orders where
 (status in ('confirmed','executing','signed','submitted','unknown')) and (lease_until is null or lease_until<=clock_timestamp())
 and (not p_signed_only or signed_payload is not null)
 order by case when signed_payload is not null then 0 else 1 end,created_at for update skip locked limit 1;
 if chosen is null then return; end if;
 return query update public.trade_orders set execution_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '180 seconds',
 status=case when status='confirmed' then 'executing' else status end where id=chosen returning *;
end $$;

create or replace function public.trade_reserve(p_id text,p_token uuid,p_cost numeric,p_max_trade numeric,p_max_daily_loss numeric,p_max_exposure numeric)
returns boolean language plpgsql security invoker set search_path=public as $$
declare o public.trade_orders; r public.trade_risk; d date := (clock_timestamp() at time zone 'UTC')::date; today numeric;
begin
 perform pg_advisory_xact_lock(74111908);
 select * into o from public.trade_orders where id=p_id for update;
 if not found or o.execution_token is distinct from p_token or o.lease_until<=clock_timestamp() or o.status<>'executing' or o.signed_payload is not null then raise exception 'Execution lease lost'; end if;
 select * into r from public.trade_risk where id=true for update;
 if r.killed then return false; end if;
 if p_cost<=0 or p_max_trade<=0 or p_max_daily_loss<=0 or p_max_exposure<=0 or p_cost>p_max_trade then return false; end if;
 if o.risk_reserved_usd>0 then return o.risk_reserved_usd>=p_cost; end if;
 insert into public.trade_daily_risk(day) values(d) on conflict do nothing;
 select used_usd into today from public.trade_daily_risk where day=d for update;
 -- Conservative bound: all capital+fees spent may be lost. No optimistic PnL, fee refund,
 -- midnight release of unresolved exposure, or automatic budget reset.
 if today+p_cost>p_max_daily_loss or r.used_usd+p_cost>least(p_max_exposure,p_max_daily_loss) then
   update public.trade_risk set killed=true,reason='Conservative loss/exposure budget exhausted',updated_at=clock_timestamp() where id=true;
   return false;
 end if;
 update public.trade_daily_risk set used_usd=used_usd+p_cost where day=d;
 update public.trade_risk set used_usd=used_usd+p_cost,updated_at=clock_timestamp() where id=true;
 update public.trade_orders set risk_reserved_usd=p_cost where id=p_id;
 return true;
end $$;

create or replace function public.trade_write_signed(p_id text,p_token uuid,p_payload text,p_hash text)
returns void language plpgsql security invoker set search_path=public as $$
begin
 perform pg_advisory_xact_lock(74111908);
 if length(p_payload)>40000 or length(p_payload)<20 or length(p_hash)>100 then raise exception 'Invalid signed payload'; end if;
 if exists(select 1 from public.trade_risk where id=true and killed) then raise exception 'Trading stopped'; end if;
 update public.trade_orders set signed_payload=p_payload,tx_hash=p_hash,status='signed'
 where id=p_id and execution_token=p_token and lease_until>clock_timestamp() and status='executing' and expires_at>clock_timestamp()
 and signed_payload is null and confirmed_update_id is not null and risk_reserved_usd>0;
 if not found then raise exception 'Signing transition rejected'; end if;
end $$;

create or replace function public.trade_transition(p_id text,p_token uuid,p_status text,p_error text)
returns void language plpgsql security invoker set search_path=public as $$
begin
 perform pg_advisory_xact_lock(74111908);
 update public.trade_orders set status=p_status,last_error=left(p_error,200),lease_until=case when p_status in ('submitted','unknown') then clock_timestamp()+interval '15 seconds' else null end
 where id=p_id and execution_token=p_token and lease_until>clock_timestamp()
 and ((status='executing' and p_status in ('failed','expired'))
   or (status in ('signed','submitted','unknown') and signed_payload is not null and p_status in ('submitted','unknown','confirmed_onchain','failed')));
 if not found then raise exception 'Execution transition rejected'; end if;
end $$;

revoke execute on function public.trade_create(text,text,text,jsonb,text,numeric,text,text,integer) from public,anon,authenticated;
revoke execute on function public.trade_confirm(text,text,text,bigint,text,integer) from public,anon,authenticated;
revoke execute on function public.trade_set_kill(boolean,text,text,integer) from public,anon,authenticated;
revoke execute on function public.trade_claim(boolean) from public,anon,authenticated;
revoke execute on function public.trade_reserve(text,uuid,numeric,numeric,numeric,numeric) from public,anon,authenticated;
revoke execute on function public.trade_write_signed(text,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.trade_transition(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.trade_create(text,text,text,jsonb,text,numeric,text,text,integer) to service_role;
grant execute on function public.trade_confirm(text,text,text,bigint,text,integer) to service_role;
grant execute on function public.trade_set_kill(boolean,text,text,integer) to service_role;
grant execute on function public.trade_claim(boolean) to service_role;
grant execute on function public.trade_reserve(text,uuid,numeric,numeric,numeric,numeric) to service_role;
grant execute on function public.trade_write_signed(text,uuid,text,text) to service_role;
grant execute on function public.trade_transition(text,uuid,text,text) to service_role;
commit;

-- END migrations/20261110_trade_execution.sql

-- BEGIN migrations/20261111_bot_retention.sql
-- Retain deduplication tombstones; never prune pending or running work.
begin;
alter table public.bot_jobs add column if not exists terminal_at timestamptz;
alter table public.bot_jobs drop constraint if exists bot_jobs_status_check;
alter table public.bot_jobs add constraint bot_jobs_status_check check(status in ('pending','running','done','failed','pruned'));
-- Legacy completion time is unknown. Start its retention window now, once only.
update public.bot_jobs set terminal_at=now() where status in ('done','failed') and terminal_at is null;

create or replace function public.bot_set_terminal_at()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if new.status in ('pending','running') then
    new.terminal_at := null;
  elsif new.status in ('done','failed') then
    if tg_op='INSERT' then
      new.terminal_at := clock_timestamp();
    elsif old.status is distinct from new.status then
      new.terminal_at := clock_timestamp();
    end if;
  end if;
  return new;
end $$;
drop trigger if exists bot_jobs_terminal_at on public.bot_jobs;
create trigger bot_jobs_terminal_at before insert or update on public.bot_jobs
for each row execute function public.bot_set_terminal_at();
create index if not exists bot_jobs_terminal_age on public.bot_jobs(terminal_at) where status in ('done','failed');
create index if not exists bot_confirmations_expiry on public.bot_confirmations(expires_at);

create or replace function public.bot_cleanup_retention(p_id text,p_attempt integer,p_batch integer default 5000)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare deleted_jobs integer; compacted_jobs integer; deleted_confirmations integer;
begin
  if p_batch is null or p_batch<1 or p_batch>10000 then raise exception 'Invalid cleanup batch'; end if;
  perform pg_advisory_xact_lock(74111907);
  if not exists(select 1 from public.bot_jobs where id=p_id and attempts=p_attempt and kind='maintenance'
                and status='running' and lease_until>clock_timestamp()) then
    raise exception 'Lease lost';
  end if;

  -- Keep resumable command intents until their job is no longer retryable.
  -- Pruned tombstones cannot be claimed and no longer contain a command payload.
  with candidates as (
    select token from public.bot_confirmations c
    where c.expires_at < now()-interval '2 days'
      and not exists(select 1 from public.bot_jobs j where j.id='update:' || c.claimed_update_id::text
                     and j.status in ('pending','running','failed'))
    order by c.expires_at,c.token limit p_batch for update of c skip locked
  )
  delete from public.bot_confirmations c using candidates x where c.token=x.token;
  get diagnostics deleted_confirmations = row_count;

  with candidates as materialized (
    select id, (status='done' and ((kind='scan' and id like 'scan:%')
      or (kind='paper' and id like 'paper-settle:%')
      or (kind='maintenance' and id like 'maintenance:%'))) as delete_row
    from public.bot_jobs
    where status in ('done','failed') and terminal_at is not null and
      terminal_at < now() - case
        when status='done' and ((kind='scan' and id like 'scan:%')
          or (kind='paper' and id like 'paper-settle:%')
          or (kind='maintenance' and id like 'maintenance:%')
          or (kind='update' and id like 'update:%')) then interval '14 days'
        else interval '30 days' end
    order by terminal_at,id limit p_batch for update skip locked
  ), deleted as (
    delete from public.bot_jobs j using candidates c where j.id=c.id and c.delete_row returning j.id
  ), compacted as (
    update public.bot_jobs j set status='pruned',payload='{}'::jsonb,lease_until=null
    from candidates c where j.id=c.id and not c.delete_row returning j.id
  )
  select (select count(*) from deleted),(select count(*) from compacted) into deleted_jobs,compacted_jobs;
  return jsonb_build_object('deletedJobs',deleted_jobs,'compactedJobs',compacted_jobs,'deletedConfirmations',deleted_confirmations);
end $$;
revoke execute on function public.bot_set_terminal_at() from public,anon,authenticated;
revoke execute on function public.bot_cleanup_retention(text,integer,integer) from public,anon,authenticated;
grant execute on function public.bot_cleanup_retention(text,integer,integer) to service_role;
commit;

-- END migrations/20261111_bot_retention.sql

-- BEGIN operations/verify.sql
-- Run as database administrator after all seven migrations. No data changes.
begin read only;
do $$
declare t text; role_name text; proc record;
begin
  foreach t in array array['watchlist','tracked_coins','blacklist_tokens','whitelist_tokens','app_settings','bot_jobs','bot_state','bot_confirmations','paper_trades','trade_orders','trade_risk','trade_daily_risk'] loop
    if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=t and c.relkind='r' and c.relrowsecurity) then
      raise exception 'Required table missing or RLS disabled: %',t;
    end if;
    foreach role_name in array array['anon','authenticated'] loop
      if has_table_privilege(role_name,'public.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_any_column_privilege(role_name,'public.'||t,'SELECT,INSERT,UPDATE,REFERENCES') then
        raise exception 'Unexpected client privilege on %.%',role_name,t;
      end if;
    end loop;
  end loop;
  if to_regprocedure('public.bot_cleanup_retention(text,integer,integer)') is null then
    raise exception 'Retention migration missing';
  end if;
  for proc in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname ~ '^(bot|paper|trade)_' loop
    foreach role_name in array array['anon','authenticated'] loop
      if has_function_privilege(role_name,proc.oid,'EXECUTE') then
        raise exception 'Unexpected client execute privilege: %.%',role_name,proc.proname;
      end if;
    end loop;
  end loop;
  if not has_function_privilege('service_role','public.bot_cleanup_retention(text,integer,integer)','EXECUTE') then
    raise exception 'Service-role cleanup privilege missing';
  end if;
end $$;
select 'Schema and client privilege checks passed; not a live provider/deployment test' as result;
commit;

-- END operations/verify.sql
