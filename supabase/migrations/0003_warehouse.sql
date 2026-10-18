-- Agent Warehouse runtime: catalog of assets, run log, and Snap audits on notes. Idempotent.
create table if not exists warehouse_assets (
  id text primary key,
  kind text not null check (kind in ('mcp_tool', 'fetch', 'sandbox', 'comms')),
  executor text not null check (executor in ('aze', 'mcp', 'http_fetch', 'instabox', 'inkbox')),
  description text not null,
  input_schema jsonb not null default '{}'::jsonb,
  endpoint text,
  tool_name text,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  agent_id text not null,
  swarm_id text,
  task text not null,
  surface text,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  attestation text not null default 'unverified' check (attestation in ('verified', 'unverified')),
  assets jsonb not null default '[]'::jsonb,
  timings jsonb not null default '[]'::jsonb,
  raw_bytes int,
  distilled_bytes int,
  cost_micro_usd jsonb not null default '{}'::jsonb,
  answer text,
  notes_filed jsonb not null default '[]'::jsonb,
  error text,
  finished_at timestamptz
);
create index if not exists runs_swarm_created on runs (swarm_id, created_at desc);
create index if not exists runs_created on runs (created_at desc);

alter table notes add column if not exists audit jsonb;

alter table warehouse_assets enable row level security;
alter table runs enable row level security;

grant select, insert, update, delete on warehouse_assets, runs to service_role;

-- Check (expect 3 rows: true): service role can use the new tables and the audit column exists.
select has_table_privilege('service_role', 'public.warehouse_assets', 'select') as assets_ok,
       has_table_privilege('service_role', 'public.runs', 'insert') as runs_ok,
       exists (select 1 from information_schema.columns where table_name = 'notes' and column_name = 'audit') as audit_col_ok;
