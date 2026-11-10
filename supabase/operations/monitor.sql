-- Read-only capacity snapshot. Save outside the repository at day 1 and day 7.
-- No chat payload, wallet address, signed bytes or credential is selected.
begin read only;
select clock_timestamp() as observed_at,current_database() as database,
       pg_database_size(current_database()) as database_bytes,
       pg_size_pretty(pg_database_size(current_database())) as database_size;
select relname,pg_relation_size(relid) as heap_bytes,pg_indexes_size(relid) as index_bytes,
       pg_total_relation_size(relid) as total_bytes,
       pg_size_pretty(pg_total_relation_size(relid)) as total_size
from pg_catalog.pg_statio_user_tables order by pg_total_relation_size(relid) desc,relname limit 15;
select kind,status,count(*) as rows,min(created_at) as oldest_created,
       min(terminal_at) as oldest_terminal,max(terminal_at) as newest_terminal
from public.bot_jobs group by kind,status order by kind,status;
select max(terminal_at) filter(where status='done') as last_completed_maintenance,
       count(*) filter(where status='failed') as failed_maintenance,
       count(*) filter(where status in ('pending','running')) as active_maintenance
from public.bot_jobs where kind='maintenance';
select schemaname,relname,n_live_tup,n_dead_tup,last_autovacuum,last_autoanalyze
from pg_stat_user_tables where schemaname='public' order by n_dead_tup desc,relname;
commit;
