// src/lib/iros/server/persistAssistantMessageToIrosMessages.ts
// iros_messages に assistant 発話を保存する最小ユーティリティ（route.ts 用）
//
// ✅ 方針（確定）
// - この関数が呼ばれたら「空でない限り必ず insert」する（ここで gate しない）
// - gate/呼ぶ呼ばないの判断は呼び出し側（/reply/route.ts）に寄せる
// - 失敗は握りつぶさず ok:false で返す（= 保存できてないのに成功扱いをしない）

import type { SupabaseClient } from '@supabase/supabase-js';

type PersistParams = {
  supabase: SupabaseClient;
  conversationId: string;
  userCode: string;
  content: string;
  meta?: any;
};

type PersistResult =
  | { ok: true; id: number; msg_uuid?: string | null; skipped?: false }
  | { ok: true; skipped: true; reason: string }
  | { ok: false; error: string; detail?: string };

function pickString(...vals: any[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

function normalizeText(v: any): string {
  return String(v ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function pickQ(meta: any): string | null {
  return pickString(
    meta?.qCode,
    meta?.q_code,
    meta?.q,
    meta?.unified?.q?.current,
    meta?.unified?.q?.now,
  );
}

function pickPhase(meta: any): string | null {
  return pickString(meta?.phase, meta?.unified?.phase);
}

function pickDepth(meta: any): string | null {
  return pickString(meta?.depth, meta?.depth_stage, meta?.unified?.depth?.stage);
}

function pickIntentLayer(meta: any): string | null {
  return pickString(
    meta?.intentLayer,
    meta?.intent_layer,
    meta?.unified?.intentLayer,
    meta?.intentLine?.focusLayer,
    meta?.intent_line?.focusLayer,
  );
}

function pickQPrimary(meta: any): string | null {
  return pickString(meta?.q_primary, meta?.qPrimary, meta?.unified?.q_primary);
}

/**
 * assistant メッセージを iros_messages に保存する
 * - ✅ この関数内では gate しない（呼ばれたら保存する）
 * - 空本文はエラーにせず skipped 扱い（沈黙ターン等で落とさない）
 */
export async function persistAssistantMessageToIrosMessages(
  params: PersistParams,
): Promise<PersistResult> {
  const { supabase } = params;

  const conversationId = String(params.conversationId ?? '').trim();
  const userCode = String(params.userCode ?? '').trim();

  if (!conversationId || !userCode) {
    return {
      ok: false,
      error: 'bad_params',
      detail: 'conversationId and userCode are required',
    };
  }

  const text = normalizeText(params.content);

  // ✅ 空本文はエラーではなく「保存不要」で返す（沈黙ターン等）
  if (!text) {
    return { ok: true, skipped: true, reason: 'empty_content' };
  }

  const meta = params.meta ?? null;

  // 付帯情報（任意）
  const q_code = pickQ(meta);
  const phase = pickPhase(meta);
  const depth_stage = pickDepth(meta);
  const intent_layer = pickIntentLayer(meta);
  const q_primary = pickQPrimary(meta);

  const payload: Record<string, any> = {
    conversation_id: conversationId,
    role: 'assistant',
    content: text,
    user_code: userCode,
    meta,
  };

  // 任意カラム（存在してるものだけ入れる運用：DB定義に合わせてOK）
  if (q_code) payload.q_code = q_code;
  if (phase) payload.phase = phase;
  if (depth_stage) payload.depth_stage = depth_stage;
  if (intent_layer) payload.intent_layer = intent_layer;
  if (q_primary) payload.q_primary = q_primary;

  const { data, error } = await supabase
    .from('iros_messages')
    .insert(payload)
    .select('id, msg_uuid')
    .single();

  if (error) {
    return {
      ok: false,
      error: 'db_insert_failed',
      detail: `${error.code ?? ''} ${error.message ?? String(error)}`.trim(),
    };
  }

  return {
    ok: true,
    id: Number((data as any)?.id),
    msg_uuid: (data as any)?.msg_uuid ?? null,
    skipped: false,
  };
}
