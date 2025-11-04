// src/lib/qcode/qlog.ts
import { SupabaseClient } from '@supabase/supabase-js';

// 既存の Q 型があれば流用。なければこの型を使う。
export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export type QLogPayload = {
  user_code: string;
  source_type: 'self' | 'sofia' | 'vision' | 'mui_stage' | 'event' | 'invite' | 'daily' | 'env';
  intent: string; // 例: 'habit' | 'check' | 'create' など
  q: QCode;
  created_at?: string; // ISO。省略時は now()
  for_date?: string; // 'YYYY-MM-DD' (JST)。省略時は今日(JST)
  extra?: Record<string, any>; // 根拠・ルール・関連IDなど
};

/** JSTの日付キー（for_date用）を返す */
export function jstDateYYYYMMDD(d = new Date()): string {
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const jst = new Date(utc + 9 * 60 * 60000);
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, '0');
  const dd = String(jst.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** q_code_logs へ1行書き込み（失敗しても throw はしない） */
export async function logQCode(admin: SupabaseClient, p: QLogPayload): Promise<void> {
  const now = p.created_at ? new Date(p.created_at) : new Date();

  const row = {
    user_code: p.user_code,
    source_type: p.source_type,
    intent: p.intent,
    q_code: { code: p.q }, // JSONB
    created_at: now.toISOString(), // DBはUTCで受ける
    for_date: p.for_date ?? jstDateYYYYMMDD(now), // 表示・集計はJST
    extra: p.extra ?? {},
  };

  const { error } = await admin.from('q_code_logs').insert(row);
  if (error) console.warn('[QLOG insert failed]', error.message, row);
}
