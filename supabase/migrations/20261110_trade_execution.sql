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
