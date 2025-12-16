// file: src/lib/iros/intentAnchor.ts
// Iros-GIGA 用：意図アンカー保存・読み出しユーティリティ（保存ゲート強化版）

import type { SupabaseClient } from '@supabase/supabase-js';

export type AnchorEventType = 'none' | 'confirm' | 'set' | 'reset';

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

function normalizeAnchorText(text: string): string {
  return (text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * メタ発話・会話制御発話はアンカーにしない（意味解釈ではなく固定ルール）
 * ※必要ならここにルールを足していく
 */
export function isMetaAnchorText(text: string): boolean {
  const t = normalizeAnchorText(text);
  if (!t) return true;

  // ① 極端に短いものはアンカーにしない（北極星として弱すぎる）
  if (t.length <= 3) return true;

  // ② 会話制御・詰問系（既存）
  if (/^覚えて(る|ます)?[？?]?$/.test(t)) return true;
  if (/^何の話(し)?[？?]?$/.test(t)) return true;
  if (/^さっき(話した|言った)(でしょ|よね)?/.test(t)) return true;

  // ③ “開発/実装/デバッグ” 会話はアンカーにしない（北極星を汚染しやすい）
  // 例: 「コードだして」「どこが問題」「エラー」「ログ」など
  if (
    /(コード|ファイル|関数|型|テーブル|カラム|SQL|schema|supabase|エラー|error|ログ|log|スタック|stack|ビルド|build|compile|tsc|typecheck|デバッグ|debug|修正|差し替え|貼って|貼りました|全文|どこのコード|どこが問題|原因|直った|直して)/i.test(
      t
    )
  ) return true;

  // ④ “メタ会話” そのもの（今回の核心）
  if (/(メタ|メタ的|仕様|設計|方針|ルール|引き継ぎ|レポート|このチャット|この会話)/.test(t)) return true;

  // ⑤ 依頼だけ・命令だけ・単発の問いだけ（北極星になりにくい）
  // 例: 「教えて」「出して」「見せて」「お願いします」単体寄り
  if (/^(教えて|出して|見せて|説明して|お願いします|お願い)[！!。\.]*$/.test(t)) return true;

  return false;
}


function shouldUpdateByEvent(anchorEventType: AnchorEventType): boolean {
  return anchorEventType === 'set' || anchorEventType === 'reset';
}

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
 * ✅ 保存ゲート：
 * - anchorEventType が set/reset のときのみ更新
 * - メタ発話は拒否
 */
export async function upsertIntentAnchorForUser(
  supabase: SupabaseClient,
  params: {
    userId: string;
    anchorText: string;
    intentStrength?: number | null;
    yLevel?: number | null;
    hLevel?: number | null;

    /** 追加：アンカーイベント。set/reset のときだけ更新する。未指定は none 扱い */
    anchorEventType?: AnchorEventType;

    /** true のときのみ、旧 anchor を履歴に積む（デフォルト true） */
    appendHistory?: boolean;

    /** 履歴の上限（デフォルト 50） */
    maxHistory?: number;
  }
): Promise<IrosIntentAnchorRow | null> {
  const {
    userId,
    anchorText,
    intentStrength = null,
    yLevel = null,
    hLevel = null,
    anchorEventType = 'none',
    appendHistory = true,
    maxHistory = 50,
  } = params;

  const nextText = normalizeAnchorText(anchorText);

  // まず既存レコードがあるか確認
  const existing = await loadIntentAnchorForUser(supabase, userId);

  // ❶ イベントが set/reset 以外 → 更新しない（既存を返すだけ）
  if (!shouldUpdateByEvent(anchorEventType)) {
    return existing;
  }

  // ❷ メタ発話 → 更新しない（既存を返すだけ）
  if (isMetaAnchorText(nextText)) {
    return existing;
  }

  // ❸ 既存なし：set/reset のときだけ作成
  if (!existing) {
    const { data, error } = await supabase
      .from('iros_intent_anchor')
      .insert({
        user_id: userId,
        anchor_text: nextText,
        intent_strength: intentStrength,
        y_level: yLevel,
        h_level: hLevel,
        anchor_history: [],
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

  // ❹ 同一テキストなら更新不要
  if (normalizeAnchorText(existing.anchor_text) === nextText) {
    return existing;
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
    // 履歴上限
    if (Number.isFinite(maxHistory) && maxHistory > 0 && nextHistory.length > maxHistory) {
      nextHistory = nextHistory.slice(nextHistory.length - maxHistory);
    }
  }

  // ✅ update は existing.id で 1件に限定（user_id 重複行があっても事故らない）
  const { data, error } = await supabase
    .from('iros_intent_anchor')
    .update({
      anchor_text: nextText,
      intent_strength: intentStrength,
      y_level: yLevel,
      h_level: hLevel,
      anchor_history: nextHistory,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
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
