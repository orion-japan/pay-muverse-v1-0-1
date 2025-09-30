// src/lib/qcode/record.ts
// Qコード記録ユーティリティ（アプリ横断 / Mu・Mirra・Sofia 兼用）

import { createClient, SupabaseClient } from '@supabase/supabase-js';

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
  | 'system';

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
  level?: number | null;
  title?: string | null;
  note?: string | null;

  extra?: Record<string, any> | null;
  created_at?: string | Date | null;
}

/* =========================
 * Supabase
 * ========================= */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE;

function sb(): SupabaseClient {
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    throw new Error('[qcode/record] Supabase env missing (SUPABASE_URL / SERVICE_ROLE)');
  }
  return createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
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
    'normal','chat','consult','diagnosis','self_post',
    'event','comment','vision','vision_check','import','system'
  ];
  if (!v) return 'normal';
  return (valid.includes(v as QIntent) ? v : 'normal') as QIntent;
}

/** source_type から agent 名（mu/mirra/sofia/self/vision/event/comment…）を推定 */
function guessAgent(source_type?: string | null): string {
  const s = (source_type || '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('mu')) return 'mu';
  if (s.includes('mirra')) return 'mirra';
  if (s.includes('sofia')) return 'sofia';
  if (s.includes('vision')) return 'vision';
  if (s.includes('self')) return 'self';
  if (s.includes('event')) return 'event';
  if (s.includes('comment')) return 'comment';
  return s; // 既知に当てはまらなければそのまま返す
}

function buildQCodeJson(args: RecordQArgs) {
  return {
    layer: clampLayer(args.layer),
    currentQ: args.q,
    polarity: clampPolarity(args.polarity),
    depthStage: clampStage(args.stage),
    // ★ メタ情報を同梱（ビュー側がここから agent を拾える）
    meta: {
      agent: guessAgent(args.source_type || null),
      intent: normalizeIntent(args.intent),
      source_type: (args.source_type || 'unknown'),
      conversation_id: args.conversation_id ?? null,
      post_id: (args.post_id != null ? String(args.post_id) : null),
    },
  };
}

/* =========================
 * 主要API
 * ========================= */
export async function recordQ(args: RecordQArgs) {
  const client = sb();

  const user_code = String(args.user_code);
  const created_at = toIso(args.created_at);
  const q = args.q as QCode;
  const stage = clampStage(args.stage);
  const layer = clampLayer(args.layer);
  const polarity = clampPolarity(args.polarity);
  const intent = normalizeIntent(args.intent);
  const source_type = (args.source_type || 'unknown') as string;

  const conversation_id =
    (args.conversation_id && String(args.conversation_id)) || null;

  const owner_user_code = args.owner_user_code ?? user_code;
  const actor_user_code = args.actor_user_code ?? user_code;

  const q_code_json = buildQCodeJson({ ...args, stage, layer, polarity });

  // 1) q_code_logs
  let logId: string | number | null = null;
  try {
    const { data, error } = await client
      .from('q_code_logs')
      .insert({
        user_code,
        conversation_id,
        post_id: args.post_id ?? null,
        owner_user_code,
        actor_user_code,
        intent,
        q,
        stage,
        source_type, // ← ログにも source_type を保存（列が無くてもエラーにはならないよう as any）
        emotion: args.emotion ?? null,
        level: args.level ?? null,
        title: args.title ?? null,
        note: args.note ?? null,
        extra: args.extra ?? null,
        created_at,
      } as any)
      .select('id')
      .single();
    if (error) throw error;
    logId = (data as any)?.id ?? null;
  } catch (e: any) {
    console.warn('[qcode/record] insert q_code_logs warn:', e?.message || e);
  }

  // 2) q_code_timeline
  let timelineId: string | number | null = null;
  try {
    const { data, error } = await client
      .from('q_code_timeline')
      .insert({
        created_at,
        user_code,
        source_type,        // ★ ここを intent ではなく source_type に修正
        intent,
        q,
        stage,
        q_code: q_code_json, // ★ meta.agent を含んだQコードJSON
        title: args.title ?? null,
        note: args.note ?? null,
      } as any)
      .select('id')
      .single();
    if (error) throw error;
    timelineId = (data as any)?.id ?? null;
  } catch (e: any) {
    console.warn('[qcode/record] insert q_code_timeline warn:', e?.message || e);
  }

  // 3) q_code_status
  try {
    const { error } = await client
      .from('q_code_status')
      .upsert(
        {
          user_code,
          current_q: q,
          depth_stage: stage,
          updated_at: created_at,
          q_hint: q,
          confidence: null,
          last_at: created_at,
        } as any,
        { onConflict: 'user_code' },
      );
    if (error) throw error;
  } catch (e: any) {
    console.warn('[qcode/record] upsert q_code_status warn:', e?.message || e);
  }

  // 4) q_code_audits（任意）
  try {
    if ('q_code_audits' in (client as any)) {
      await client.from('q_code_audits').insert({
        user_code,
        q,
        stage,
        source_type,
        intent,
        conversation_id,
        created_at,
        meta: { layer, polarity, logId, timelineId, extra: args.extra ?? null },
      } as any);
    }
  } catch {
    /* ignore */
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
    ids: { logId, timelineId },
    q_code: q_code_json,
  };
}

/* =========================
 * エージェント別ラッパ
 * ========================= */
export async function recordQFromMu(args: Omit<RecordQArgs, 'source_type'> & { source_type?: string }) {
  return recordQ({ source_type: 'muai', ...args });
}
export async function recordQFromMirra(args: Omit<RecordQArgs, 'source_type'> & { source_type?: string }) {
  return recordQ({ source_type: 'mirra', ...args });
}
export async function recordQFromSofia(args: Omit<RecordQArgs, 'source_type'> & { source_type?: string }) {
  return recordQ({ source_type: 'sofia', ...args });
}
export async function recordQFromVision(args: Omit<RecordQArgs, 'source_type'> & { source_type?: string }) {
  return recordQ({ source_type: 'vision', ...args });
}
export async function recordQFromSelf(args: Omit<RecordQArgs, 'source_type'> & { source_type?: string }) {
  return recordQ({ source_type: 'self', ...args });
}
export async function recordQFromComment(args: Omit<RecordQArgs, 'source_type'> & { source_type?: string }) {
  return recordQ({ source_type: 'comment', ...args });
}
export async function recordQFromEvent(args: Omit<RecordQArgs, 'source_type'> & { source_type?: string }) {
  return recordQ({ source_type: 'event', ...args });
}

/* =========================
 * バッチ / 簡易
 * ========================= */
export async function recordQBatch(items: RecordQArgs[]) {
  const results: Array<{ ok: true; value: any } | { ok: false; error: any; input: RecordQArgs }> = [];
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
