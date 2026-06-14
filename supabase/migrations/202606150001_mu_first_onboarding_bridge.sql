-- Mu first diagnosis -> main IROS bridge

alter table public.users
add column if not exists name text;

alter table public.users
add column if not exists mu_first_onboarding_pending boolean not null default false;

alter table public.users
add column if not exists mu_first_onboarding_activated_at timestamptz;

alter table public.users
add column if not exists mu_first_onboarding_consumed_at timestamptz;

create index if not exists idx_mu_first_followup_logs_user_diag_created
on public.mu_first_followup_logs (user_code, diagnosis_log_id, created_at asc);
