// src/lib/iros/server/loadLatestGoalByUserCode.ts
// iros — Latest Goal loader (user_code based, conversationId ignored)
// 方針：DBから直近N件の user 発話を取り、TS側でスコアリングして1件返す

import type { SupabaseClient } from '@supabase/supabase-js';

export type LatestGoalHit = {
  id: string;
  goalText: string;
  createdAt: string; // ISO-ish string from DB
  score: number;
};

type Row = {
  id: string | number;
  user_code: string;
  role: string;
  content: string | null;
  created_at: string;
};

function scoreGoalishText(raw: string): number {
  const content = raw.trim();
  if (!content) return 0;

  let score = 0;

  // 強い一致（目標宣言に近い）
  if (/(今日の目標|目標(なんだっけ|覚えて|は))/i.test(content)) score += 300;

  // 一般一致
  if (/(目標|ゴール|やること|今日(は|の)|本日)/i.test(content)) score += 200;

  // 書き出し一致
  if (/^(今日は|本日は|今日|いまから)\s*/i.test(content)) score += 120;

  // 「質問っぽい」ものを減点（goal recall Q を拾いにくくする）
  if (/[?？]\s*$/.test(content)) score -= 100;
  if (/(覚えてる|なんだっけ|見つか|ある\?|ある？)/i.test(content)) score -= 80;

  // あまりに短いのは弱い
  if (content.length < 6) score -= 40;

  return Math.max(0, score);
}

export async function loadLatestGoalByUserCode(
  supabase: SupabaseClient,
  userCode: string,
  opts?: { limit?: number }
): Promise<LatestGoalHit | null> {
  const limit = Math.max(20, Math.min(400, opts?.limit ?? 200));

  // 直近の user 発話を取る（conversation_id は見ない）
  const { data, error } = await supabase
    .from('iros_messages_normalized')
    .select('id,user_code,role,content,created_at')
    .eq('user_code', userCode)
    .eq('role', 'user')
    .not('content', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  const rows = (data as Row[]) ?? [];
  if (!rows.length) return null;

  let best: LatestGoalHit | null = null;

  for (const r of rows) {
    const text = (r.content ?? '').trim();
    if (!text) continue;

    const score = scoreGoalishText(text);
    if (score <= 0) continue;

    const hit: LatestGoalHit = {
      id: String(r.id),
      goalText: text,
      createdAt: r.created_at,
      score,
    };

    if (!best) {
      best = hit;
      continue;
    }

    // score優先、同点なら新しい方
    if (hit.score > best.score) best = hit;
    else if (hit.score === best.score) {
      if (hit.createdAt > best.createdAt) best = hit;
    }
  }

  return best;
}
