-- Mu first diagnosis follow-up mini chat
-- Separate from normal Mu credits and screenshot diagnosis credits.

alter table public.users
add column if not exists first_followup_credit_count integer not null default 0;

create table if not exists public.mu_first_followup_logs (
  id uuid primary key default gen_random_uuid(),
  user_code text not null,
  diagnosis_log_id uuid,
  question text not null,
  answer text not null,
  source text default 'mu_first_followup',
  credit_used integer not null default 1,
  created_at timestamptz default now()
);

create table if not exists public.mu_first_followup_credit_grants (
  id uuid primary key default gen_random_uuid(),
  user_code text not null,
  amount integer not null default 3,
  reason text not null,
  campaign text not null,
  granted_at timestamptz default now(),
  unique (user_code, campaign)
);

create index if not exists idx_mu_first_followup_logs_user_code
on public.mu_first_followup_logs (user_code, created_at desc);

create index if not exists idx_mu_first_followup_logs_diagnosis_log_id
on public.mu_first_followup_logs (diagnosis_log_id, created_at asc);

create index if not exists idx_mu_first_followup_credit_grants_user_code
on public.mu_first_followup_credit_grants (user_code, granted_at desc);

create or replace function public.consume_first_followup_credit(p_user_code text)
returns boolean
language plpgsql
security definer
as $$
begin
  update public.users
  set first_followup_credit_count = first_followup_credit_count - 1
  where user_code = p_user_code
    and first_followup_credit_count > 0;

  return found;
end;
$$;

create or replace function public.grant_first_followup_credit(
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

  insert into public.mu_first_followup_credit_grants (
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
  set first_followup_credit_count = first_followup_credit_count + p_amount
  where user_code = p_user_code;

  return true;
end;
$$;
