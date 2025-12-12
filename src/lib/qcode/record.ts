// src/lib/qcode/record.ts
// Qコード記録ユーティリティ（アプリ横断 / Mu・Mirra・Sofia 兼用）
//
// ✅ 方針: DB書き込みは qcode-adapter.writeQCodeWithEnv に一本化する
// - q_code_logs（履歴）
// - q_code_timeline_store（view元）
// - user_q_now（最新スナップショット）

import { writeQCodeWithEnv } from './qcode-adapter';

/* =========================
 * 型
 * ========================= */
export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
export type QStage = 'S1' | 'S2' | 'S3';
export type QLayer = 'inner' | 'outer';
export type QPolarity = 'ease' | 'now';

export type QIntent =
  | 'normal'
  | 'chat'
  | 'consult'
  | 'diagnosis'
  | 'self_post'
  | 'event'
  | 'comment'
  | 'vision'
  | 'vision_check'
  | 'import'
  | 'system'
  | 'auto'
  | 'iros_chat';

export interface RecordQArgs {
  user_code: string;

  conversation_id?: string | null;
  post_id?: string | number | null;
  owner_user_code?: string | null;
  actor_user_code?: string | null;

  q: QCode;
  stage?: QStage;
  layer?: QLayer;
  polarity?: QPolarity;
  intent: QIntent;
  source_type?: string | null;

  emotion?: string | null;
  level?: number | string | null;
  title?: string | null;
  note?: string | null;

  extra?: Record<string, any> | null;
  created_at?: string | Date | null;
}

/* =========================
 * ユーティリティ
 * ========================= */
const nowIso = () => new Date().toISOString();

function toIso(v?: string | Date | null): string {
  if (!v) return nowIso();
  return typeof v === 'string' ? v : new Date(v).toISOString();
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

// Intent 正規化（未知値は normal）
function normalizeIntent(v?: string | null): QIntent {
  const valid: QIntent[] = [
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
    'auto',
    'iros_chat',
  ];
  if (!v) return 'normal';
  return (valid.includes(v as QIntent) ? v : 'normal') as QIntent;
}

/* =========================
 * 主要API
 * ========================= */
export async function recordQ(args: RecordQArgs) {
  const user_code = String(args.user_code);
  const created_at = toIso(args.created_at);

  const q = args.q as QCode;
  const stage = clampStage(args.stage);
  const layer = clampLayer(args.layer);
  const polarity = clampPolarity(args.polarity);
  const intent = normalizeIntent(args.intent);

  const source_type = String(args.source_type || 'unknown');

  const conversation_id =
    (args.conversation_id && String(args.conversation_id)) || null;

  const owner_user_code = args.owner_user_code ?? user_code;
  const actor_user_code = args.actor_user_code ?? user_code;

  const postIdStr = args.post_id != null ? String(args.post_id) : null;

  const levelStr =
    args.level == null
      ? null
      : typeof args.level === 'string'
        ? args.level
        : String(args.level);

  // ✅ DB書き込みは一本化（adapter が q_code_logs / q_code_timeline_store / user_q_now を更新）
  let ids: { logId: string | null; timelineId: number | null } = {
    logId: null,
    timelineId: null,
  };
  let q_code: any = null;

  try {
    const res = await writeQCodeWithEnv({
      user_code,
      source_type,
      intent,

      q,
      stage,
      layer,
      polarity,

      conversation_id,
      post_id: postIdStr,
      title: args.title ?? null,
      note: args.note ?? null,

      created_at,

      // 旧 record.ts で別カラムだったものも、落とさず extra に保持
      extra: {
        ...(args.extra ?? {}),
        owner_user_code,
        actor_user_code,
        emotion: args.emotion ?? null,
        level: levelStr,
        _from: 'qcode/record.recordQ',
      },
    });

    ids = res.ids;
    q_code = res.q_code;
  } catch (e: any) {
    console.warn('[qcode/record] writeQCodeWithEnv warn:', e?.message || e);
  }

  return {
    ok: true as const,
    user_code,
    q,
    stage,
    layer,
    polarity,
    intent,
    source_type,
    conversation_id,
    created_at,
    ids,
    q_code,
  };
}

/* =========================
 * エージェント別ラッパ
 * ========================= */
export async function recordQFromMu(
  args: Omit<RecordQArgs, 'source_type'> & { source_type?: string },
) {
  return recordQ({ source_type: 'muai', ...args });
}
export async function recordQFromMirra(
  args: Omit<RecordQArgs, 'source_type'> & { source_type?: string },
) {
  return recordQ({ source_type: 'mirra', ...args });
}
export async function recordQFromSofia(
  args: Omit<RecordQArgs, 'source_type'> & { source_type?: string },
) {
  return recordQ({ source_type: 'sofia', ...args });
}
export async function recordQFromVision(
  args: Omit<RecordQArgs, 'source_type'> & { source_type?: string },
) {
  return recordQ({ source_type: 'vision', ...args });
}
export async function recordQFromSelf(
  args: Omit<RecordQArgs, 'source_type'> & { source_type?: string },
) {
  return recordQ({ source_type: 'self', ...args });
}
export async function recordQFromComment(
  args: Omit<RecordQArgs, 'source_type'> & { source_type?: string },
) {
  return recordQ({ source_type: 'comment', ...args });
}
export async function recordQFromEvent(
  args: Omit<RecordQArgs, 'source_type'> & { source_type?: string },
) {
  return recordQ({ source_type: 'event', ...args });
}

/* =========================
 * バッチ / 簡易
 * ========================= */
export async function recordQBatch(items: RecordQArgs[]) {
  const results: Array<
    { ok: true; value: any } | { ok: false; error: any; input: RecordQArgs }
  > = [];
  for (const it of items) {
    try {
      const x = await recordQ(it);
      results.push({ ok: true, value: x });
    } catch (e) {
      results.push({ ok: false, error: e, input: it });
    }
  }
  return results;
}

export function inferQFromText(text: string): QCode {
  const t = text || '';
  if (/(怒|苛|いらいら|伸び|挑戦|焦り)/.test(t)) return 'Q2';
  if (/(不安|整え|安定|土台|落ち着)/.test(t)) return 'Q3';
  if (/(恐れ|怖|緊張|浄化|手放|流す|滞)/.test(t)) return 'Q4';
  if (/(情熱|燃え|集中|衝動|没頭|空虚)/.test(t)) return 'Q5';
  return 'Q1';
}

export async function quickRecordQ(params: {
  user_code: string;
  text: string;
  intent?: QIntent;
  source_type?: string;
  conversation_id?: string | null;
  stage?: QStage;
  created_at?: string | Date | null;
  extra?: Record<string, any> | null;
}) {
  const q = inferQFromText(params.text);
  return recordQ({
    user_code: params.user_code,
    intent: normalizeIntent(params.intent),
    source_type: params.source_type ?? 'muai',
    q,
    stage: params.stage ?? 'S1',
    conversation_id: params.conversation_id ?? null,
    created_at: params.created_at ?? null,
    extra: { ...(params.extra ?? {}), inferred_from: 'text' },
  });
}

export default recordQ;
