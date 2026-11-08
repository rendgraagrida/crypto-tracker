-- Run deliberately against a non-production environment first. Existing rows remain unassigned.
begin;
alter table public.whitelist_tokens add column if not exists chain_network text;
commit;
