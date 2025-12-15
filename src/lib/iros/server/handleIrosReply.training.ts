// file: src/lib/iros/server/handleIrosReply.training.ts
// iros - Training saver (canonical meta -> training payload)
// 目的:
// - saveIrosTrainingSample に渡す payload を一箇所で作る
// - situation_summary を “必ず” 入れる（canonical > metaForSave > userText）
// - gates などで skipTraining=true の場合は呼ばない想定だが、ここでも防御する
//
// 方針:
// - canonical を正として扱う
// - metaForSave は補助（unified / soulNote / intentLine など）を拾うためにだけ使う
// - 実体は src/lib/iros/server/saveTrainingSample.ts（= saveIrosTrainingSample）を利用

import type { CanonicalMeta } from './handleIrosReply.meta';
import { saveIrosTrainingSample } from './saveTrainingSample';

export type SaveTrainingContext = {
  supabase: any; // SupabaseClient 型を使っているなら置き換え可
  userCode: string;
  conversationId: string;

  // このターンの入力
  userText: string;

  // LLMの最終テキスト（renderEngine 後）
  assistantText: string;

  // canonicalizeIrosMeta の結果（ここが正）
  canonical: CanonicalMeta;

  // 既存 meta（補助情報）
  metaForSave?: any;

  // 呼び出し元で gating 済みでも、念のためここでも防御
  skipTraining?: boolean;

  // trace/debug
  traceId?: string | null;
};

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function toStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

function normalizeSummary(s: string | null, maxLen = 240): string | null {
  if (!s) return null;
  let t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // “同じ文2回” の圧縮
  const half = Math.floor(t.length / 2);
  if (half >= 8) {
    const a = t.slice(0, half).trim();
    const b = t.slice(half).trim();
    if (a && b && a === b) t = a;
  }

  return t.length > maxLen ? t.slice(0, maxLen) + '…' : t;
}

function pickSituationSummary(args: {
  canonical: CanonicalMeta;
  metaForSave?: any;
  userText: string;
}): string {
  const { canonical, metaForSave, userText } = args;

  // 1) canonical（最優先）
  const c = normalizeSummary(toStr(canonical.situationSummary ?? null), 240);
  if (c) return c;

  // 2) metaForSave / unified（救済）
  const m = isObj(metaForSave) ? metaForSave : {};
  const unified = isObj(m.unified) ? m.unified : {};

  const fromMeta =
    normalizeSummary(toStr(m.situationSummary ?? null), 240) ??
    normalizeSummary(toStr(m.situation_summary ?? null), 240) ??
    normalizeSummary(toStr((unified as any)?.situation?.summary ?? null), 240) ??
    null;

  if (fromMeta) return fromMeta;

  // 3) userText（最終fallback：必ず入る）
  return normalizeSummary(userText, 240) ?? userText.trim();
}

function pickSituationTopic(args: {
  canonical: CanonicalMeta;
  metaForSave?: any;
}): string | null {
  const { canonical, metaForSave } = args;

  const c = toStr(canonical.situationTopic ?? null);
  if (c) return c;

  const m = isObj(metaForSave) ? metaForSave : {};
  const unified = isObj(m.unified) ? m.unified : {};

  return (
    toStr(m.situationTopic ?? null) ??
    toStr(m.situation_topic ?? null) ??
    toStr(m.topic_label ?? null) ??
    toStr(m.topic ?? null) ??
    toStr((unified as any)?.situation?.topic ?? null) ??
    toStr((unified as any)?.topic ?? null) ??
    null
  );
}

function pickSkipTraining(metaForSave: any): boolean {
  const m = isObj(metaForSave) ? metaForSave : {};
  if ((m as any).skipTraining === true) return true;
  if ((m as any).skip_training === true) return true;

  const unified = isObj((m as any).unified) ? (m as any).unified : {};
  if ((unified as any).skipTraining === true) return true;
  if ((unified as any).skip_training === true) return true;

  return false;
}

/**
 * Training に渡す “正規化 payload”
 * - saveIrosTrainingSample の受け取りに合わせて適宜フィールド名を寄せる
 */
export function buildTrainingPayload(ctx: SaveTrainingContext): Record<string, any> {
  const { userCode, conversationId, userText, assistantText, canonical, metaForSave, traceId } = ctx;

  const situation_summary = pickSituationSummary({ canonical, metaForSave, userText });
  const situation_topic = pickSituationTopic({ canonical, metaForSave });

  // 3軸（canonical）
  const q_code = canonical.qCode;
  const depth_stage = canonical.depth;
  const phase = canonical.phase;

  // 数値（canonical）
  const self_acceptance = canonical.selfAcceptance;
  const y_level = canonical.yLevel;
  const h_level = canonical.hLevel;

  // “学習に効く最小セット” を基本にする
  const payload: Record<string, any> = {
    user_code: userCode,
    conversation_id: conversationId,

    // 学習サンプル本文
    user_text: userText,
    assistant_text: assistantText,

    // situation（★必須：ここが今回の修正ポイント）
    situation_summary,
    situation_topic,

    // 3軸
    q_code,
    depth_stage,
    phase,

    // 数値
    self_acceptance,
    y_level,
    h_level,

    // 任意: intent_anchor（canonical）
    intent_anchor: canonical.intent_anchor ?? null,

    // trace/debug
    trace_id: traceId ?? null,
  };

  // 任意: unified/soulNote を同梱したい場合だけ（肥大化注意）
  // const m = isObj(metaForSave) ? metaForSave : {};
  // const unified = isObj(m.unified) ? m.unified : {};
  // payload.unified = unified;

  return payload;
}

/**
 * training 保存（実処理）
 * - src/lib/iros/server/saveTrainingSample.ts の saveIrosTrainingSample を呼ぶ
 */
export async function saveTrainingSampleFromReply(
  ctx: SaveTrainingContext,
): Promise<{
  ok: boolean;
  payload?: any;
  error?: any;
}> {
  const { supabase, skipTraining, metaForSave } = ctx;

  // 1) 呼び出し側の明示 skip
  if (skipTraining) return { ok: true, payload: null };

  // 2) meta 側の skipTraining
  if (pickSkipTraining(metaForSave)) return { ok: true, payload: null };

  const payload = buildTrainingPayload(ctx);

  try {
    await saveIrosTrainingSample({
      supabase,
      ...payload,
    } as any);

    return { ok: true, payload };
  } catch (e) {
    console.error('[IROS/Training] saveIrosTrainingSample failed', e);
    return { ok: false, payload, error: e };
  }
}
