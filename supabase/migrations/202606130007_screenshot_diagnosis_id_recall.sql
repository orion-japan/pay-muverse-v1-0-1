-- Screenshot diagnosis ID recall foundation
-- Adds ir-diagnosis-like recall fields for Mu screenshot diagnosis logs.

alter table public.mu_screenshot_diagnosis_logs
add column if not exists display_id bigint;

alter table public.mu_screenshot_diagnosis_logs
add column if not exists mode text not null default 'first';

alter table public.mu_screenshot_diagnosis_logs
add column if not exists conversation_id text;

alter table public.mu_screenshot_diagnosis_logs
add column if not exists classification_json jsonb;

alter table public.mu_screenshot_diagnosis_logs
add column if not exists credit_cost integer not null default 0;

alter table public.mu_screenshot_diagnosis_logs
add column if not exists created_at timestamptz default now();

update public.mu_screenshot_diagnosis_logs
set created_at = coalesce(created_at, used_at, now())
where created_at is null;

with numbered as (
  select
    id,
    row_number() over (
      partition by user_code
      order by coalesce(used_at, created_at, now()) asc, id asc
    ) as rn
  from public.mu_screenshot_diagnosis_logs
  where display_id is null
)
update public.mu_screenshot_diagnosis_logs l
set display_id = numbered.rn
from numbered
where l.id = numbered.id;

create unique index if not exists idx_mu_screenshot_diagnosis_logs_user_display_id
on public.mu_screenshot_diagnosis_logs (user_code, display_id)
where display_id is not null;

create index if not exists idx_mu_screenshot_diagnosis_logs_user_display_recent
on public.mu_screenshot_diagnosis_logs (user_code, display_id desc);

create index if not exists idx_mu_screenshot_diagnosis_logs_user_created
on public.mu_screenshot_diagnosis_logs (user_code, created_at desc);
