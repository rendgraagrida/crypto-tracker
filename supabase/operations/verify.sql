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
