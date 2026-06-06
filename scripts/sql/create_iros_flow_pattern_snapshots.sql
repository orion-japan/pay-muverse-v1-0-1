-- scripts/sql/create_iros_flow_pattern_snapshots.sql
-- Mu / IROS Flow Pattern Memory
-- Phase 2-1: 通常会話 chat の状態パターン保存用

create table if not exists public.iros_flow_pattern_snapshots (
  id uuid primary key default gen_random_uuid(),

  user_code text not null,
  conversation_id uuid null,
  message_id bigint null,

  source_type text not null default 'chat',
  source_id text null,

  target_label text null,
  target_type text null,

  q_code text null,
  q_primary text null,
  e_turn text null,
  depth_stage text null,
  phase text null,
  self_acceptance numeric null,

  relation_focus text null,
  emotional_temperature text null,

  observed_stage text null,
  primary_stage text null,
  secondary_stage text null,

  will_rotation text null,

  situation_topic text null,
  situation_summary text null,

  followup_kind text null,
  goal_kind text null,

  diagnosis_id bigint null,
  diagnosis_text_head text null,
  user_text_head text null,
  assistant_text_head text null,

  tags text[] not null default '{}',
  meta jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

create index if not exists idx_iros_flow_pattern_snapshots_user_created
  on public.iros_flow_pattern_snapshots (user_code, created_at desc);

create index if not exists idx_iros_flow_pattern_snapshots_conversation_created
  on public.iros_flow_pattern_snapshots (conversation_id, created_at desc);

create index if not exists idx_iros_flow_pattern_snapshots_source_type
  on public.iros_flow_pattern_snapshots (source_type);

create index if not exists idx_iros_flow_pattern_snapshots_target_label
  on public.iros_flow_pattern_snapshots (target_label);

create index if not exists idx_iros_flow_pattern_snapshots_state
  on public.iros_flow_pattern_snapshots (depth_stage, phase, q_primary);

create index if not exists idx_iros_flow_pattern_snapshots_tags
  on public.iros_flow_pattern_snapshots using gin (tags);

create index if not exists idx_iros_flow_pattern_snapshots_meta
  on public.iros_flow_pattern_snapshots using gin (meta);

comment on table public.iros_flow_pattern_snapshots is
  'Mu/IROS Flow Pattern Memory snapshots. Stores per-turn state patterns for later similar-flow lookup.';

comment on column public.iros_flow_pattern_snapshots.source_type is
  'chat, diagnosis, diagnosis_followup, clarification, relationship, field';

comment on column public.iros_flow_pattern_snapshots.meta is
  'Internal debug/source context. Do not expose directly to users.';
