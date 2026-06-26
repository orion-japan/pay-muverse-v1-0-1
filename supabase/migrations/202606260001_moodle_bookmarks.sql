create table if not exists public.moodle_bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_code text not null,
  target_key text not null,
  course_id integer,
  chapter_id text,
  chapter_title text,
  position_index integer not null default 0,
  paragraph_index integer not null default 0,
  char_offset integer not null default 0,
  audio_time numeric,
  mode text not null default 'reading',
  source text not null default 'moodle',
  updated_from text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint moodle_bookmarks_user_target_unique unique (user_code, target_key)
);

create index if not exists moodle_bookmarks_user_code_idx
  on public.moodle_bookmarks (user_code);

create index if not exists moodle_bookmarks_target_key_idx
  on public.moodle_bookmarks (target_key);

create index if not exists moodle_bookmarks_updated_at_idx
  on public.moodle_bookmarks (updated_at desc);

alter table public.moodle_bookmarks enable row level security;

create policy if not exists "moodle_bookmarks_service_role_all"
  on public.moodle_bookmarks
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
