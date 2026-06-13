-- Store Mu first screenshot diagnosis result text

alter table public.mu_screenshot_diagnosis_logs
add column if not exists diagnosis_text text;
