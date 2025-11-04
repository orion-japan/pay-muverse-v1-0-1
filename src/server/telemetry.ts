// src/server/telemetry.ts
import { supabase } from '@/lib/supabase';

/** Telemetry Event 型（meta 追加） */
export type TelemetryEvent = {
  kind: string; // "api" | "page" | "auth" | ...
  path: string; // API パスや URL
  status?: number | null; // HTTP ステータス相当
  latency_ms?: number | null; // 処理時間(ms)
  note?: string | null; // エラーメッセージ等
  ua?: string | null; // UserAgent
  session_id?: string | null; // セッションID
  uid?: string | null; // Firebase UID
  user_code?: string | null; // 数値 user_code
  meta?: Record<string, any> | null; // 追加情報（jsonb）
};

/**
 * Telemetry ログを DB に書き込む
 * - 失敗しても throw せず warn のみにする（本処理を落とさない）
 */
export async function logEvent(ev: TelemetryEvent): Promise<void> {
  try {
    const payload = {
      kind: ev.kind,
      path: ev.path,
      status: ev.status ?? null,
      latency_ms: ev.latency_ms ?? null,
      note: ev.note ?? null,
      ua: ev.ua ?? null,
      session_id: ev.session_id ?? null,
      uid: ev.uid ?? null,
      user_code: ev.user_code ?? null,
      meta: ev.meta ?? {}, // ★ 追加
      // created_at は DB 側 default now()
    };

    const { error } = await supabase.from('telemetry_event').insert([payload]);
    if (error) console.warn('⚠ telemetry insert failed:', error.message);
  } catch (e: any) {
    console.warn('⚠ telemetry logEvent exception:', e?.message ?? e);
  }
}
