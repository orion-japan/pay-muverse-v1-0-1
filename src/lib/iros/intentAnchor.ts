// file: src/lib/iros/intentAnchor.ts
// Iros-GIGA 用：意図アンカー保存・読み出しユーティリティ

import type { SupabaseClient } from '@supabase/supabase-js';

/** DB行の型（最低限） */
export type IrosIntentAnchorRow = {
  id: string;
  user_id: string; // uuid
  anchor_text: string;
  intent_strength: number | null;
  y_level: number | null;
  h_level: number | null;
  anchor_history: any[]; // jsonb 配列として扱う
  created_at: string;
  updated_at: string;
};

/**
 * 特定ユーザーの意図アンカーを取得
 * - なければ null を返す
 */
export async function loadIntentAnchorForUser(
  supabase: SupabaseClient,
  userId: string
): Promise<IrosIntentAnchorRow | null> {
  const { data, error } = await supabase
    .from('iros_intent_anchor')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('[IROS][intentAnchor] load error', error);
    return null;
  }

  if (!data || data.length === 0) return null;

  const row = data[0] as IrosIntentAnchorRow;
  // anchor_history が null の場合は空配列に正規化
  return {
    ...row,
    anchor_history: (row.anchor_history ?? []) as any[],
  };
}

/**
 * 意図アンカーの保存（insert / update 両対応）
 *
 * - すでにアンカーがある場合：
 *   - 旧アンカーを anchor_history に 1件追記した上で更新
 * - まだない場合：
 *   - 新規レコードとして作成
 */
export async function upsertIntentAnchorForUser(
  supabase: SupabaseClient,
  params: {
    userId: string;
    anchorText: string;
    intentStrength?: number | null;
    yLevel?: number | null;
    hLevel?: number | null;
    /** true のときのみ、旧 anchor を履歴に積む（デフォルト true） */
    appendHistory?: boolean;
  }
): Promise<IrosIntentAnchorRow | null> {
  const {
    userId,
    anchorText,
    intentStrength = null,
    yLevel = null,
    hLevel = null,
    appendHistory = true,
  } = params;

  // まず既存レコードがあるか確認
  const existing = await loadIntentAnchorForUser(supabase, userId);

  if (!existing) {
    // 新規作成
    const { data, error } = await supabase
      .from('iros_intent_anchor')
      .insert({
        user_id: userId,
        anchor_text: anchorText,
        intent_strength: intentStrength,
        y_level: yLevel,
        h_level: hLevel,
        anchor_history: [], // 初回は空
      })
      .select('*');

    if (error) {
      console.error('[IROS][intentAnchor] insert error', error);
      return null;
    }
    if (!data || data.length === 0) return null;

    const row = data[0] as IrosIntentAnchorRow;
    return {
      ...row,
      anchor_history: (row.anchor_history ?? []) as any[],
    };
  }

  // 既存あり → 履歴の更新ロジック
  let nextHistory = (existing.anchor_history ?? []) as any[];

  if (appendHistory) {
    const nowIso = new Date().toISOString();
    nextHistory = [
      ...nextHistory,
      {
        at: nowIso,
        anchor: existing.anchor_text,
        intent_strength: existing.intent_strength,
        y_level: existing.y_level,
        h_level: existing.h_level,
      },
    ];
  }

  const { data, error } = await supabase
    .from('iros_intent_anchor')
    .update({
      anchor_text: anchorText,
      intent_strength: intentStrength,
      y_level: yLevel,
      h_level: hLevel,
      anchor_history: nextHistory,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .select('*');

  if (error) {
    console.error('[IROS][intentAnchor] update error', error);
    return null;
  }
  if (!data || data.length === 0) return null;

  const row = data[0] as IrosIntentAnchorRow;
  return {
    ...row,
    anchor_history: (row.anchor_history ?? []) as any[],
  };
}
