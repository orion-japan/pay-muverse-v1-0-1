-- Muverse first diagnosis flow
-- Conversation credit remains in the existing credit system.
-- Screenshot diagnosis credit is separated from normal conversation credit.

alter table public.users
add column if not exists screenshot_credit_count integer not null default 0;

create table if not exists public.mu_screenshot_diagnosis_logs (
  id uuid primary key default gen_random_uuid(),
  user_code text not null,
  model text,
  source text default 'mu_first',
  media_code text,
  credit_used integer not null default 1,
  used_at timestamptz default now()
);

create table if not exists public.mu_screenshot_credit_grants (
  id uuid primary key default gen_random_uuid(),
  user_code text not null,
  amount integer not null default 1,
  reason text not null,
  campaign text,
  granted_at timestamptz default now(),
  unique (user_code, campaign)
);

create table if not exists public.user_journey_events (
  id uuid primary key default gen_random_uuid(),
  user_code text not null,
  event_type text not null,
  source text,
  campaign text,
  page_path text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_mu_screenshot_diagnosis_logs_user_code
on public.mu_screenshot_diagnosis_logs (user_code, used_at desc);

create index if not exists idx_mu_screenshot_credit_grants_user_code
on public.mu_screenshot_credit_grants (user_code, granted_at desc);

create index if not exists idx_user_journey_events_user_code
on public.user_journey_events (user_code, created_at desc);

create index if not exists idx_user_journey_events_event_type
on public.user_journey_events (event_type, created_at desc);

create or replace function public.consume_screenshot_credit(p_user_code text)
returns boolean
language plpgsql
security definer
as $$
begin
  update public.users
  set screenshot_credit_count = screenshot_credit_count - 1
  where user_code = p_user_code
    and screenshot_credit_count > 0;

  return found;
end;
$$;

create or replace function public.grant_screenshot_credit(
  p_user_code text,
  p_amount integer,
  p_reason text,
  p_campaign text
)
returns boolean
language plpgsql
security definer
as $$
begin
  if p_amount <= 0 then
    return false;
  end if;

  insert into public.mu_screenshot_credit_grants (
    user_code,
    amount,
    reason,
    campaign
  )
  values (
    p_user_code,
    p_amount,
    p_reason,
    p_campaign
  )
  on conflict (user_code, campaign)
  do nothing;

  if not found then
    return false;
  end if;

  update public.users
  set screenshot_credit_count = screenshot_credit_count + p_amount
  where user_code = p_user_code;

  return true;
end;
$$;
