
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
