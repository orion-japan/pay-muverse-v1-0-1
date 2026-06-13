-- Store structured Mu seed for first screenshot diagnosis

alter table public.mu_screenshot_diagnosis_logs
add column if not exists diagnosis_seed_json jsonb;
