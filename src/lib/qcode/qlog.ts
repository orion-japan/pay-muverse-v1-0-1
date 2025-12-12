// src/lib/qcode/qlog.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeQCode } from './qcode-adapter';

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
export type QStage = 'S1' | 'S2' | 'S3';
export type QLayer = 'inner' | 'outer';
export type QPolarity = 'ease' | 'now';

const VALID_INTENTS = [
  'normal',
  'chat',
  'consult',
  'diagnosis',
  'self_post',
  'event',
  'comment',
  'vision',
  'vision_check',
  'import',
  'system',
] as const;

export type QIntent = (typeof VALID_INTENTS)[number];

export type QLogPayload = {
  user_code: string;
  source_type:
    | 'self'
    | 'sofia'
    | 'vision'
    | 'mui_stage'
    | 'event'
    | 'invite'
    | 'daily'
    | 'env';
  intent: string; // 未知は normal に落とす
  q: QCode;

  stage?: QStage; // 省略時 S1
  layer?: QLayer; // 省略時 inner
  polarity?: QPolarity; // 省略時 now

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

function clampStage(s?: QStage | null): QStage {
  return s === 'S2' || s === 'S3' ? s : 'S1';
}
function clampLayer(l?: QLayer | null): QLayer {
  return l === 'outer' ? 'outer' : 'inner';
}
function clampPolarity(p?: QPolarity | null): QPolarity {
  return p === 'ease' ? 'ease' : 'now';
}
function normalizeIntent(v?: string | null): QIntent {
  if (!v) return 'normal';
  return (VALID_INTENTS as readonly string[]).includes(v) ? (v as QIntent) : 'normal';
}

/**
 * ✅ 統一ログ：qcode-adapter.writeQCode() に委譲
 *
 * - q_code_logs（履歴）
 * - q_code_timeline_store（view の元）
 * - user_q_now（最新スナップショット）
 *
 * 失敗しても throw しない（従来互換）
 */
export async function logQCode(admin: SupabaseClient, p: QLogPayload): Promise<void> {
  const now = p.created_at ? new Date(p.created_at) : new Date();

  const user_code = String(p.user_code);
  const source_type = String(p.source_type || 'unknown');
  const intent = normalizeIntent(p.intent);

  const stage = clampStage(p.stage);
  const layer = clampLayer(p.layer);
  const polarity = clampPolarity(p.polarity);

  const for_date = p.for_date ?? jstDateYYYYMMDD(now);

  try {
    await writeQCode(admin, {
      user_code,
      source_type,
      intent,
      q: p.q,
      stage,
      layer,
      polarity,
      created_at: now.toISOString(),
      extra: {
        ...(p.extra ?? {}),
        for_date,
        _from: 'qlog',
        q_raw: p.q,
        stage_raw: p.stage ?? null,
        layer_raw: p.layer ?? null,
        polarity_raw: p.polarity ?? null,
      },
    });
  } catch (e: any) {
    console.warn('[QLOG write failed]', e?.message || e, {
      user_code,
      source_type,
      intent,
      q: p.q,
      stage,
      layer,
      polarity,
      for_date,
    });
  }
}
