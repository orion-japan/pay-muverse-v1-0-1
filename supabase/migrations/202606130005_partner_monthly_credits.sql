-- Master Partner monthly credit grant support
-- partner = UI label "パートナー", formal name "マスターパートナー"
-- Monthly grant amount: 3,500 credits

create table if not exists public.credit_grant_logs (
  id uuid primary key default gen_random_uuid(),
  user_code text not null,
  user_type text,
  grant_type text not null,
  amount integer not null check (amount > 0),
  grant_month text not null check (grant_month ~ '^\d{4}-\d{2}$'),
  reason text,
  op_id text,
  metadata jsonb not null default '{}'::jsonb,
  granted_at timestamptz not null default now()
);

alter table public.credit_grant_logs
  add column if not exists user_code text;

alter table public.credit_grant_logs
  add column if not exists user_type text;

alter table public.credit_grant_logs
  add column if not exists grant_type text;

alter table public.credit_grant_logs
  add column if not exists amount integer;

alter table public.credit_grant_logs
  add column if not exists grant_month text;

alter table public.credit_grant_logs
  add column if not exists reason text;

alter table public.credit_grant_logs
  add column if not exists op_id text;

alter table public.credit_grant_logs
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.credit_grant_logs
  add column if not exists granted_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'credit_grant_logs_user_type_month_unique'
      and conrelid = 'public.credit_grant_logs'::regclass
  ) then
    alter table public.credit_grant_logs
      add constraint credit_grant_logs_user_type_month_unique
      unique (user_code, grant_type, grant_month);
  end if;
end $$;

create index if not exists credit_grant_logs_grant_month_idx
  on public.credit_grant_logs (grant_type, grant_month);

create index if not exists credit_grant_logs_user_code_idx
  on public.credit_grant_logs (user_code);

comment on table public.credit_grant_logs is
  'Credit grant audit log. Used for idempotent monthly Master Partner grants.';

comment on column public.credit_grant_logs.grant_type is
  'Example: monthly_partner';

comment on column public.credit_grant_logs.grant_month is
  'YYYY-MM in Japan time for monthly grants.';
