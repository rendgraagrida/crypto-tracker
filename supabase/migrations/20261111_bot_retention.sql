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
