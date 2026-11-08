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
