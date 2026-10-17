-- Prior Art: initial schema. Only the service role reads/writes (RLS on, no policies).
create extension if not exists pg_trgm;

do $$ begin
  create type note_kind as enum (
    'friction', 'worked_well', 'wish', 'workaround', 'cost', 'trust', 'comparison', 'barrier', 'missing_data'
  );
exception when duplicate_object then null;
end $$;

create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind note_kind not null,
  category text not null,
  surface text not null,
  surface_display text not null,
  what varchar(240) not null,
  tool text,
  error_class text,
  tokens_spent int,
  dollars_spent numeric,
  workaround text,
  teaser varchar(80),
  wish text,
  visibility text not null default 'public' check (visibility = 'public'),
  attestation text not null default 'unverified' check (attestation in ('verified', 'unverified')),
  quarantined bool not null default true,
  tier text not null default 'experiment',
  hidden bool not null default false
);
create index if not exists notes_surface_tool_idx on notes (surface, tool);
create index if not exists notes_error_class_trgm_idx on notes using gin (error_class gin_trgm_ops);

-- Payout addresses live apart from notes and are never returned by any read path.
create table if not exists note_payouts (
  note_id uuid primary key references notes on delete cascade,
  payout_address text not null
);

create table if not exists queries (
  id bigserial primary key,
  at timestamptz not null default now(),
  surface text not null,
  tool text,
  matched int not null
);

create table if not exists unlocks (
  id bigserial primary key,
  note_id uuid references notes,
  at timestamptz not null default now(),
  amount_micro bigint not null,
  tx_hash text not null,
  network text not null
);

create table if not exists ledger (
  id bigserial primary key,
  unlock_id bigint references unlocks,
  note_id uuid references notes,
  party text check (party in ('filer', 'platform')),
  amount_micro bigint not null
);

create table if not exists settings (
  key text primary key,
  value jsonb not null
);
insert into settings (key, value) values
  ('filing_enabled', 'true'::jsonb),
  ('unlock_enabled', 'true'::jsonb),
  ('price_micro', '50000'::jsonb),
  ('filer_bps', '7000'::jsonb)
on conflict (key) do nothing;

alter table notes enable row level security;
alter table note_payouts enable row level security;
alter table queries enable row level security;
alter table unlocks enable row level security;
alter table ledger enable row level security;
alter table settings enable row level security;

-- Visible notes on a surface; tool exact if given; error_class by trigram similarity if given.
-- reports = visible notes sharing the same (surface, tool, error_class), nulls equal.
create or replace function find_matches(p_surface text, p_tool text, p_error_class text, p_limit int)
returns table (note jsonb, reports int)
language sql stable
as $$
  select to_jsonb(n) as note,
         (select count(*)::int from notes m
           where m.hidden = false
             and m.surface = n.surface
             and m.tool is not distinct from n.tool
             and m.error_class is not distinct from n.error_class) as reports
  from notes n
  where n.hidden = false
    and n.surface = p_surface
    and (p_tool is null or n.tool = p_tool)
    and (p_error_class is null or n.error_class is null or similarity(n.error_class, p_error_class) > 0.3)
  order by reports desc, n.created_at desc
  limit p_limit;
$$;

-- One unlock + its two ledger rows, atomically (a function body runs in one transaction).
create or replace function record_unlock(
  p_note_id uuid, p_amount bigint, p_filer bigint, p_platform bigint, p_tx text, p_network text
) returns void
language plpgsql
as $$
declare v_unlock bigint;
begin
  insert into unlocks (note_id, amount_micro, tx_hash, network)
    values (p_note_id, p_amount, p_tx, p_network)
    returning id into v_unlock;
  insert into ledger (unlock_id, note_id, party, amount_micro) values
    (v_unlock, p_note_id, 'filer', p_filer),
    (v_unlock, p_note_id, 'platform', p_platform);
end;
$$;

-- Per (surface, kind) counts over visible notes; surface_display = newest visible note's display.
create or replace function surface_kind_counts(p_surface text default null)
returns table (surface text, surface_display text, kind text, n int)
language sql stable
as $$
  select n.surface,
         (select d.surface_display from notes d
           where d.surface = n.surface and d.hidden = false
           order by d.created_at desc limit 1),
         n.kind::text,
         count(*)::int
  from notes n
  where n.hidden = false and (p_surface is null or n.surface = p_surface)
  group by n.surface, n.kind;
$$;

-- Dashboard totals (visible notes only).
create or replace function store_stats()
returns jsonb
language sql stable
as $$
  select jsonb_build_object(
    'notes', (select count(*) from notes where hidden = false),
    'verified', (select count(*) from notes where hidden = false and attestation = 'verified'),
    'unverified', (select count(*) from notes where hidden = false and attestation = 'unverified'),
    'queries', (select count(*) from queries),
    'unlocks', (select count(*) from unlocks),
    'filer_earned_micro', (select coalesce(sum(amount_micro), 0) from ledger where party = 'filer')
  );
$$;

-- Only the service role may call these.
revoke execute on function find_matches(text, text, text, int) from public, anon, authenticated;
revoke execute on function record_unlock(uuid, bigint, bigint, bigint, text, text) from public, anon, authenticated;
revoke execute on function surface_kind_counts(text) from public, anon, authenticated;
revoke execute on function store_stats() from public, anon, authenticated;
grant execute on function find_matches(text, text, text, int) to service_role;
grant execute on function record_unlock(uuid, bigint, bigint, bigint, text, text) to service_role;
grant execute on function surface_kind_counts(text) to service_role;
grant execute on function store_stats() to service_role;
