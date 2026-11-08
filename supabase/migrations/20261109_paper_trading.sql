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
