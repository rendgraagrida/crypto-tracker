\set ON_ERROR_STOP on
-- Run only on the disposable cluster after applying the seven migrations.
insert into public.bot_jobs(id,kind,payload,status,attempts,lease_until,created_at) values
 ('maintenance:test','maintenance','{}','running',3,now()+interval '1 day',now()),
 ('scan:old','scan','{"secret":1}','done',0,null,now()-interval '100 days'),
 ('paper-settle:old','paper','{"secret":1}','done',0,null,now()),
 ('maintenance:old','maintenance','{"secret":1}','done',0,null,now()),
 ('update:1','update','{"secret":1}','done',0,null,now()),
 ('send:old','send','{"secret":1}','done',0,null,now()),
 ('scan:failed','scan','{"secret":1}','failed',0,null,now()),
 ('scan:wrong-kind','send','{"secret":1}','done',0,null,now()),
 ('update:2','update','{"secret":1}','pending',0,null,now()),
 ('update:3','update','{"secret":1}','running',1,now()+interval '1 day',now()),
 ('update:4','update','{"secret":1}','failed',0,null,now()),
 ('scan:recent','scan','{"secret":1}','done',0,null,now()-interval '100 days'),
 ('scan:boundary','scan','{"secret":1}','done',0,null,now()),
 ('send:boundary','send','{"secret":1}','done',0,null,now()),
 ('update:boundary','update','{"secret":1}','done',0,null,now()),
 ('retention:tombstone','send','{}','pruned',0,null,now());
update public.bot_jobs set terminal_at=now()-interval '31 days' where id in ('scan:old','paper-settle:old','maintenance:old','update:1','update:4','send:old','scan:failed','scan:wrong-kind');
update public.bot_jobs set terminal_at=now()-interval '14 days' where id in ('scan:boundary','update:boundary');
update public.bot_jobs set terminal_at=now()-interval '30 days' where id='send:boundary';
insert into public.bot_jobs(id,kind,payload,status) values('send:legacy','send','{"legacy":true}','done');
update public.bot_jobs set terminal_at=null where id='send:legacy';
-- Existing product policies must survive base-schema reapplication.
create policy retention_existing_policy on public.watchlist for select to service_role using (false);
insert into public.bot_confirmations(token,user_id,chat_id,command,expires_at,claimed_update_id) values
 ('expired','u','c','command',now()-interval '3 days',null),
 ('pending','u','c','command',now()-interval '3 days',2),
 ('running','u','c','command',now()-interval '3 days',3),
 ('failed','u','c','command',now()-interval '3 days',4),
 ('done','u','c','command',now()-interval '3 days',1),
 ('recent','u','c','command',now()-interval '1 day',null);
insert into public.bot_state(key,value) values('cursor:retention-test','{"height":123}') on conflict(key) do update set value=excluded.value;
insert into public.paper_trades(signal_id,user_id,chat_id,entry_at,trade) values('retention-test','u','c',now(),'{"marks":{}}');
insert into public.trade_daily_risk(day,used_usd) values('2001-01-01',17) on conflict(day) do update set used_usd=17;
insert into public.trade_orders(id,user_id,chat_id,quote,quote_hash,notional_usd,mode,expires_at)
 values('retention-order','u','c','{}','hash',1,'manual',now()+interval '1 day');
update public.trade_risk set used_usd=19,reason='retention-test' where id;

-- Replay the actual migrations with maintenance and tombstone rows already present.
\ir ../migrations/20261106_base_schema.sql
\ir ../migrations/20261107_bot_runtime.sql
\ir ../migrations/20261107_whitelist_chain.sql
\ir ../migrations/20261108_identity_constraints.sql
\ir ../migrations/20261109_paper_trading.sql
\ir ../migrations/20261110_trade_execution.sql
\ir ../migrations/20261111_bot_retention.sql

begin;
do $$
declare r jsonb; before_time timestamptz; i integer;
begin
  if (select terminal_at from public.bot_jobs where id='scan:old') > now()-interval '30 days' then raise exception 'Reapply changed terminal time'; end if;
  if not exists(select 1 from public.bot_jobs where id='retention:tombstone' and status='pruned') then raise exception 'Reapply lost tombstone'; end if;
  if not exists(select 1 from public.bot_jobs where id='send:legacy' and terminal_at >= now()-interval '1 minute') then raise exception 'Legacy completion not conservatively backfilled'; end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='watchlist' and policyname='retention_existing_policy') then raise exception 'Existing product policies changed'; end if;
  if has_function_privilege('anon','public.bot_cleanup_retention(text,integer,integer)','execute') or
     has_function_privilege('authenticated','public.bot_cleanup_retention(text,integer,integer)','execute') or
     not has_function_privilege('service_role','public.bot_cleanup_retention(text,integer,integer)','execute') or
     has_function_privilege('anon','public.bot_set_terminal_at()','execute') or
     has_function_privilege('authenticated','public.bot_set_terminal_at()','execute') then raise exception 'Function permissions'; end if;
  foreach i in array array[0,10001] loop
    begin perform public.bot_cleanup_retention('maintenance:test',3,i); raise exception 'Invalid batch accepted'; exception when raise_exception then if sqlerrm='Invalid batch accepted' then raise; end if; end;
  end loop;
  begin perform public.bot_cleanup_retention('maintenance:test',3,null); raise exception 'Null batch accepted'; exception when raise_exception then if sqlerrm='Null batch accepted' then raise; end if; end;
  begin perform public.bot_cleanup_retention('maintenance:test',2,1); raise exception 'Stale attempt accepted'; exception when raise_exception then if sqlerrm='Stale attempt accepted' then raise; end if; end;
  begin perform public.bot_cleanup_retention('update:3',1,1); raise exception 'Wrong kind accepted'; exception when raise_exception then if sqlerrm='Wrong kind accepted' then raise; end if; end;
  update public.bot_jobs set lease_until=clock_timestamp()-interval '1 second' where id='maintenance:test';
  begin perform public.bot_cleanup_retention('maintenance:test',3,1); raise exception 'Expired lease accepted'; exception when raise_exception then if sqlerrm='Expired lease accepted' then raise; end if; end;
  update public.bot_jobs set lease_until=clock_timestamp()+interval '1 day' where id='maintenance:test';

  -- A strict boundary is evaluated within the same transaction timestamp.
  update public.bot_jobs set terminal_at=now()-interval '14 days' where id in ('scan:boundary','update:boundary');
  update public.bot_jobs set terminal_at=now()-interval '30 days' where id='send:boundary';
  insert into public.bot_confirmations(token,user_id,chat_id,command,expires_at) values('boundary','u','c','command',now()-interval '2 days');
  r:=public.bot_cleanup_retention('maintenance:test',3,1);
  if (r->>'deletedJobs')::int+(r->>'compactedJobs')::int<>1 or (r->>'deletedConfirmations')::int<>1 then raise exception 'Batch cap/result: %',r; end if;
  r:=public.bot_cleanup_retention('maintenance:test',3,5000);
  if (r->>'deletedJobs')::int+(r->>'compactedJobs')::int<>7 or (r->>'deletedConfirmations')::int<>1 then raise exception 'Remaining cleanup result: %',r; end if;
  if not exists(select 1 from public.bot_jobs where id='update:4' and status='pruned' and payload='{}'::jsonb) then raise exception 'Failed update not compacted'; end if;
  r:=public.bot_cleanup_retention('maintenance:test',3);
  if (r->>'deletedConfirmations')::int<>1 then raise exception 'Pruned command retained private intent'; end if;
  r:=public.bot_cleanup_retention('maintenance:test',3);
  if r <> '{"deletedJobs":0,"compactedJobs":0,"deletedConfirmations":0}'::jsonb then raise exception 'Cleanup not idempotent: %',r; end if;
  if exists(select 1 from public.bot_jobs where id in ('scan:old','paper-settle:old','maintenance:old')) then raise exception 'Periodic job not deleted'; end if;
  if (select count(*) from public.bot_jobs where id in ('update:1','update:4','send:old','scan:failed','scan:wrong-kind') and status='pruned' and payload='{}'::jsonb)<>5 then raise exception 'Tombstones missing'; end if;
  if (select count(*) from public.bot_jobs where id in ('scan:recent','scan:boundary','send:boundary','update:boundary') and status='done')<>4 then raise exception 'Recent completion or boundary pruned'; end if;
  if (select count(*) from public.bot_confirmations where token in ('pending','running','recent','boundary'))<>4 or exists(select 1 from public.bot_confirmations where token in ('expired','done','failed')) then raise exception 'Confirmation retention'; end if;
  insert into public.bot_jobs(id,kind,payload) values('update:1','update','{"replayed":true}') on conflict(id) do nothing;
  if not exists(select 1 from public.bot_jobs where id='update:1' and status='pruned' and payload='{}'::jsonb) then raise exception 'Deduplication lost'; end if;
  if (select value from public.bot_state where key='cursor:retention-test') <> '{"height":123}'::jsonb or
     not exists(select 1 from public.paper_trades where signal_id='retention-test' and trade='{"marks":{}}'::jsonb) or
     not exists(select 1 from public.trade_orders where id='retention-order' and quote='{}'::jsonb and notional_usd=1) or
     not exists(select 1 from public.trade_risk where id and used_usd=19 and reason='retention-test') or
     (select used_usd from public.trade_daily_risk where day='2001-01-01')<>17 then raise exception 'Cursor or ledger changed'; end if;
  select terminal_at into before_time from public.bot_jobs where id='scan:recent';
  update public.bot_jobs set payload='{"other":1}' where id='scan:recent';
  if (select terminal_at from public.bot_jobs where id='scan:recent') is distinct from before_time then raise exception 'Timestamp reset without transition'; end if;
  update public.bot_jobs set status='pending' where id='scan:recent';
  if (select terminal_at from public.bot_jobs where id='scan:recent') is not null then raise exception 'Pending timestamp not cleared'; end if;
  update public.bot_jobs set status='done' where id='scan:recent';
  if (select terminal_at from public.bot_jobs where id='scan:recent') is null then raise exception 'Completion timestamp not set'; end if;
end $$;
rollback;
