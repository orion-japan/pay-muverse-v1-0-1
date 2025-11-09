// src/lib/iros/memory/store.ts
import { createClient } from '@supabase/supabase-js';
import type { ResonanceMetrics, RootIds, EvidenceCard } from './types';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/** 短期メモの最新1件を取得 */
export async function getShortTermSummary(root: RootIds) {
  const { data, error } = await sb
    .from('iros_memory_sessions')
    .select('*')
    .eq('user_id', root.userId)
    .eq('conversation_id', root.conversationId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data as (null | {
    id: string;
    short_summary: string;
    turns: number;
    updated_at: string;
  });
}

/** 短期メモのupsert */
export async function upsertShortTermSummary(
  root: RootIds,
  short_summary: string,
  turns: number
) {
  const { data, error } = await sb
    .from('iros_memory_sessions')
    .upsert({
      user_id: root.userId,
      conversation_id: root.conversationId,
      short_summary,
      turns,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'user_id,conversation_id'
    })
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** 直近のエピソードを時系列で取得（最大5件） */
export async function getRecentEpisodes(root: RootIds, limit = 5) {
  const { data, error } = await sb
    .from('iros_memory_episodes')
    .select('id,title,summary,metrics,created_at,trust_score')
    .eq('user_id', root.userId)
    .eq('conversation_id', root.conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    title: row.title,
    date: row.created_at,
    snippet: row.summary.slice(0, 280),
    trust: row.trust_score ?? 0.8,
  })) as EvidenceCard[];
}

/** エピソード保存 */
export async function saveEpisode(opts: {
  root: RootIds;
  title: string;
  summary: string;
  decisions?: string;
  todos?: string;
  tags?: string[];
  metrics?: ResonanceMetrics;
  source_message_ids?: string[];
  trust_score?: number;
}) {
  const { data, error } = await sb
    .from('iros_memory_episodes')
    .insert({
      user_id: opts.root.userId,
      conversation_id: opts.root.conversationId,
      title: opts.title,
      summary: opts.summary,
      decisions: opts.decisions ?? null,
      todos: opts.todos ?? null,
      tags: opts.tags ?? null,
      metrics: opts.metrics ?? null,
      source_message_ids: opts.source_message_ids ?? null,
      trust_score: opts.trust_score ?? 0.8,
    })
    .select('id')
    .maybeSingle();

  if (error) throw error;
  return data?.id as string;
}

/** 監査ログ／課金イベント保存 */
export async function auditEvent(root: RootIds, event: string, credits: number, reason?: string, source_ids?: string[]) {
  const { error } = await sb
    .from('iros_memory_audit')
    .insert({
      user_id: root.userId,
      conversation_id: root.conversationId,
      event,
      reason: reason ?? null,
      source_ids: source_ids ?? null,
      credits
    });

  if (error) throw error;
}
