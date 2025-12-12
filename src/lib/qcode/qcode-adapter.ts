// src/lib/qcode/qcode-adapter.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { QSymbol } from '../qcodes';

/**
 * 目的:
 * - Qコード保存の入口を一本化する
 * - DBスキーマ差分（旧/新）でも動くように、INSERTをフォールバックする
 *
 * 重要:
 * - for_date（JST日付）を必ず埋める（API集計が for_date 絞り込み前提のため）
 */

export type QCodeForDB = {
  code: QSymbol;
  current_q?: QSymbol | null;
  depth_stage?: string | null;
  intent?: string | null;
  ts_at?: string | null;
};

export type QWriteInput = {
  user_code: string;
  source_type: string;
  intent?: string | null;

  q: QSymbol;
  stage?: string | null;
  layer?: 'inner' | 'outer' | null;
  polarity?: 'ease' | 'now' | null;

  conversation_id?: string | null;
  post_id?: string | null;
  title?: string | null;
  note?: string | null;

  for_date?: string | null; // 'YYYY-MM-DD' (JST)
  created_at?: string | Date | null;
  extra?: Record<string, any> | null;
};

export function asDbQCode(qc: {
  current_q: QSymbol;
  depth_stage?: string | null;
  intent?: string | null;
  ts_at?: string | null;
}): QCodeForDB {
  return {
    code: qc.current_q,
    current_q: qc.current_q,
    depth_stage: qc.depth_stage ?? null,
    intent: qc.intent ?? null,
    ts_at: qc.ts_at ?? null,
  };
}

/* =========================
 * internal utils
 * ========================= */
const nowIso = () => new Date().toISOString();

function toIso(v?: string | Date | null): string {
  if (!v) return nowIso();
  return typeof v === 'string' ? v : new Date(v).toISOString();
}

function clampStage(s?: string | null): string {
  return s === 'S2' || s === 'S3' ? s : 'S1';
}
function clampLayer(l?: 'inner' | 'outer' | null): 'inner' | 'outer' {
  return l === 'outer' ? 'outer' : 'inner';
}
function clampPolarity(p?: 'ease' | 'now' | null): 'ease' | 'now' {
  return p === 'ease' ? 'ease' : 'now';
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
}

/** JSTの日付キー（for_date用）を返す */
export function jstDateYYYYMMDD(d = new Date()): string {
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const jst = new Date(utc + 9 * 60 * 60000);
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, '0');
  const dd = String(jst.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 'YYYY-MM-DD' のみ許可。ダメなら null */
function normalizeForDate(v?: string | null): string | null {
  if (!v) return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** q_code jsonb（CHECK制約 / view の参照キーを満たす最小要件） */
function buildQCodeJson(p: {
  q: QSymbol;
  stage: string;
  layer: 'inner' | 'outer';
  polarity: 'ease' | 'now';
  source_type: string;
  intent: string;
  conversation_id: string | null;
  post_id_raw: string | null;
  title: string | null;
  for_date: string;
}) {
  return {
    layer: p.layer,
    currentQ: p.q,
    polarity: p.polarity,
    depthStage: p.stage,
    meta: {
      agent: String(p.source_type || 'unknown'),
      intent: String(p.intent || 'normal'),
      source_type: String(p.source_type || 'unknown'),
      conversation_id: p.conversation_id,
      post_id: p.post_id_raw,
      title: p.title,
      for_date: p.for_date,
    },
  };
}

/* =========================
 * client builders
 * ========================= */

export function makeAdminClient(sbUrl: string, srKey: string): SupabaseClient {
  return createClient(sbUrl, srKey, { auth: { persistSession: false } });
}

export function makeAdminClientFromEnv(): SupabaseClient {
  const SUPABASE_URL =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_ROLE =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE;

  if (!SUPABASE_URL || !SERVICE_ROLE) {
    throw new Error('[qcode-adapter] Supabase env missing (SUPABASE_URL / SERVICE_ROLE)');
  }
  return makeAdminClient(SUPABASE_URL, SERVICE_ROLE);
}

/* =========================
 * unified write (with fallback)
 * ========================= */

function isMissingColumnError(e: any): boolean {
  const m = String(e?.message || e || '');
  return m.includes('column') && m.includes('does not exist');
}

async function tryInsertSingle<T>(
  admin: SupabaseClient,
  table: string,
  payload: any,
  idField: string,
): Promise<T> {
  const { data, error } = await admin.from(table).insert(payload as any).select(idField).single();
  if (error) throw error;
  return data as any;
}

/**
 * ✅ これが「唯一の書き込み入口」
 * - q_code_logs（履歴）
 * - q_code_timeline_store（view の元）
 * - user_q_now（最新スナップショット）
 *
 * ※ DBスキーマ差分に備えて、INSERTをフォールバックする
 */
export async function writeQCode(
  admin: SupabaseClient,
  input: QWriteInput,
): Promise<{
  ok: true;
  created_at: string;
  for_date: string;
  q_code: any;
  ids: { logId: string | null; timelineId: any | null };
}> {
  const created_at = toIso(input.created_at);

  const user_code = String(input.user_code);
  const source_type = String(input.source_type || 'unknown');
  const intent = String(input.intent || 'normal');

  const q = input.q;
  const stage = clampStage(input.stage);
  const layer = clampLayer(input.layer);
  const polarity = clampPolarity(input.polarity);

  const conversation_id = input.conversation_id ? String(input.conversation_id) : null;

  const postIdStr = input.post_id != null ? String(input.post_id) : null;
  const post_id = postIdStr && isUuid(postIdStr) ? postIdStr : null;

  const for_date =
    normalizeForDate(input.for_date) ??
    normalizeForDate((input.extra as any)?.for_date) ??
    jstDateYYYYMMDD(new Date(created_at));

  const q_code_json = buildQCodeJson({
    q,
    stage,
    layer,
    polarity,
    source_type,
    intent,
    conversation_id,
    post_id_raw: postIdStr,
    title: input.title ?? null,
    for_date,
  });

  const extraMerged = {
    ...(input.extra ?? {}),
    post_id_raw: post_id ? null : postIdStr,
    title: input.title ?? null,
    _via: 'qcode-adapter.writeQCode',
  };

  // 1) q_code_logs（新→旧フォールバック）
  let logId: string | null = null;
  try {
    // 新しめ想定（created_at / for_date / source_type / q_code / extra）
    const data = await tryInsertSingle<any>(admin, 'q_code_logs', {
      created_at,
      for_date,
      user_code,
      intent,
      source_type,
      q_code: q_code_json,
      extra: extraMerged,
      // 任意列（存在しなければ missing-column になるので入れない）
      // conversation_id / note / post_id などは “確実にある” と分かってから足す
    }, 'id');
    logId = data?.id ?? null;
  } catch (e: any) {
    if (!isMissingColumnError(e)) throw e;

    // 旧め想定（最低限）
    const data = await tryInsertSingle<any>(admin, 'q_code_logs', {
      created_at,
      for_date,
      user_code,
      intent,
      q_code: q_code_json,
      extra: extraMerged,
    }, 'id');
    logId = data?.id ?? null;
  }

// 2) q_code_timeline_store
let timelineId: number | null = null;
{
  const { data, error } = await admin
    .from('q_code_timeline_store')
    .insert({
      created_at,
      user_code,
      source_type,
      intent,
      q,
      stage,
      q_code: q_code_json,
      title: input.title ?? null,
      note: input.note ?? null,

      // ✅ 追加：集計キー（date型カラムに 'YYYY-MM-DD' を入れる）
      for_date,
    } as any)
    .select('id')
    .single();

  if (error) throw error;
  timelineId = (data as any)?.id ?? null;
}

  // 3) user_q_now（currentq/depthstage → current_q/depth_stage フォールバック）
  try {
    const { error } = await admin.from('user_q_now').upsert(
      {
        user_code,
        currentq: q,
        depthstage: stage,
        updated_at: created_at,
      } as any,
      { onConflict: 'user_code' },
    );
    if (error) throw error;
  } catch (e: any) {
    if (!isMissingColumnError(e)) throw e;

    const { error } = await admin.from('user_q_now').upsert(
      {
        user_code,
        current_q: q,
        depth_stage: stage,
        updated_at: created_at,
      } as any,
      { onConflict: 'user_code' },
    );
    if (error) throw error;
  }

  return {
    ok: true,
    created_at,
    for_date,
    q_code: q_code_json,
    ids: { logId, timelineId },
  };
}

export async function writeQCodeWithEnv(input: QWriteInput) {
  const admin = makeAdminClientFromEnv();
  return writeQCode(admin, input);
}

export async function writeQCodeWithSR(
  sbUrl: string,
  srKey: string,
  input: QWriteInput,
) {
  const admin = makeAdminClient(sbUrl, srKey);
  return writeQCode(admin, input);
}
