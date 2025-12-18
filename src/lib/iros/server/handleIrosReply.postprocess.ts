// file: src/lib/iros/server/handleIrosReply.postprocess.ts
// iros - Postprocess (minimal first + meta safety + rotationState single source)

import type { SupabaseClient } from '@supabase/supabase-js';
import type { IrosStyle } from '@/lib/iros/system';
import { isMetaAnchorText } from '@/lib/iros/intentAnchor';

// ★ 追加：MemoryRecall から pastStateNote を作る
import { preparePastStateNoteForTurn } from '@/lib/iros/memoryRecall';

export type PostProcessReplyArgs = {
  supabase: SupabaseClient;
  userCode: string;
  conversationId: string;
  userText: string;

  effectiveStyle: IrosStyle | string | null;
  requestedMode: string | undefined;

  orchResult: any;

  /** ✅ 追加（任意）：履歴が来るなら将来ここでも使える */
  history?: unknown[];

  /** ✅ 追加（任意）：topicLabel を明示できる */
  topicLabel?: string | null;

  /** ✅ 追加（任意）：limit を外から調整 */
  pastStateLimit?: number;

  /** ✅ 追加（任意）：常に recent_topic fallback するか */
  forceRecentTopicFallback?: boolean;
};

export type PostProcessReplyOutput = {
  assistantText: string;
  metaForSave: any;
};

function toNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function extractAssistantText(orchResult: any): string {
  if (orchResult && typeof orchResult === 'object') {
    const r: any = orchResult;
    const c = toNonEmptyString(r.content);
    if (c) return c;
    const t = toNonEmptyString(r.text);
    if (t) return t;

    // JSON stringify fallback（循環参照は避ける）
    try {
      return JSON.stringify(r);
    } catch {
      return String(r);
    }
  }
  return String(orchResult ?? '');
}

function pickIntentAnchorText(meta: any): string {
  const a = meta?.intentAnchor;
  const t = (a?.anchor_text ?? '') || (a?.anchorText ?? '') || (a?.text ?? '') || '';
  return String(t);
}

/**
 * ✅ intentAnchor 汚染防止
 * - LLMや途中処理が “状況文/メタ/開発会話” を intentAnchor に入れても落とす
 * - DB由来っぽい Row（id/user_id/created_at 等）なら温存しやすくする
 */
function sanitizeIntentAnchor(meta: any): any {
  if (!meta || typeof meta !== 'object') return meta;
  if (!meta.intentAnchor) return meta;

  const text = pickIntentAnchorText(meta);
  const hasText = Boolean(text && text.trim());

  const a = meta.intentAnchor;
  const looksLikeRow =
    Boolean(a?.id) || Boolean(a?.user_id) || Boolean(a?.created_at) || Boolean(a?.updated_at);

  // 1) テキストが無い → 捨てる
  if (!hasText) {
    delete meta.intentAnchor;
    return meta;
  }

  // 2) intentAnchor の内容がメタ判定に引っかかる → 捨てる
  if (isMetaAnchorText(text)) {
    delete meta.intentAnchor;
    return meta;
  }

  // 3) Rowでもなく、イベント(set/reset)でもない → 擬似アンカーとして捨てる
  const ev: string | null =
    meta.anchorEventType ??
    meta.intentAnchorEventType ??
    meta.anchor_event_type ??
    meta.intent_anchor_event_type ??
    null;

  const shouldBeRealEvent = ev === 'set' || ev === 'reset';

  if (!looksLikeRow && !shouldBeRealEvent) {
    delete meta.intentAnchor;
    return meta;
  }

  return meta;
}

/* =========================================================
   RotationState single source (postprocess side)
   - ここで metaForSave.rotationState を必ず「正規形」に揃える
   - render / persist は rotationState だけを見る前提に寄せる
========================================================= */

type DescentGate = 'closed' | 'offered' | 'accepted';
type SpinLoop = 'SRI' | 'TCF';

function normalizeDescentGate(v: any): DescentGate {
  if (v == null) return 'closed';

  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'closed' || s === 'offered' || s === 'accepted') return s as DescentGate;
    return 'closed';
  }

  // 互換：boolean のとき（旧）
  if (typeof v === 'boolean') return v ? 'accepted' : 'closed';

  return 'closed';
}

function normalizeSpinLoop(v: any): SpinLoop | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  if (s === 'SRI' || s === 'TCF') return s as SpinLoop;
  return null;
}

function normalizeDepth(v: any): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

function ensureRotationState(meta: any, orchResult: any): any {
  const m: any = meta && typeof meta === 'object' ? meta : {};

  // orchResult 由来の rotation 候補も拾う（metaに入ってない場合の取りこぼし防止）
  const or: any = orchResult && typeof orchResult === 'object' ? orchResult : null;

  const rot =
    m.rotation ??
    m.rotationState ??
    m.spin ??
    (m.will && (m.will.rotation ?? m.will.spin)) ??
    (or && (or.rotation ?? or.rotationState ?? or.spin ?? (or.will && (or.will.rotation ?? or.will.spin)))) ??
    null;

  const spinLoop =
    normalizeSpinLoop(rot?.spinLoop ?? rot?.loop) ?? normalizeSpinLoop(m.spinLoop) ?? null;

  const descentGate = normalizeDescentGate(rot?.descentGate ?? m.descentGate);

  const depth =
    normalizeDepth(rot?.nextDepth ?? rot?.depth) ?? normalizeDepth(m.depth) ?? null;

  // ここで “唯一の正規形” に揃える
  m.spinLoop = spinLoop;
  m.descentGate = descentGate;
  m.depth = depth;

  m.rotationState = {
    spinLoop,
    descentGate,
    depth,
    reason: rot?.reason ?? undefined,
  };

  return m;
}

export async function postProcessReply(args: PostProcessReplyArgs): Promise<PostProcessReplyOutput> {
  const { orchResult, supabase, userCode, userText } = args;

  const assistantText = extractAssistantText(orchResult);

  // meta は result.meta をベースにする（なければ空オブジェクトで統一）
  const metaRaw =
    orchResult && typeof orchResult === 'object' && (orchResult as any).meta
      ? (orchResult as any).meta
      : null;

  const metaForSave: any = metaRaw && typeof metaRaw === 'object' ? { ...metaRaw } : {};

  // ✅ “北極星事故” の最後の止血（ここでも落とす）
  sanitizeIntentAnchor(metaForSave);

  // ✅ rotationState を postprocess 時点で一本化しておく
  // （handleIrosReply.ts 側にも bridge があってOK。ここは「取りこぼし防止」）
  try {
    ensureRotationState(metaForSave, orchResult);
  } catch (e) {
    console.warn('[IROS/PostProcess] ensureRotationState failed', e);
  }

  // =========================================================
  // ✅ ここが「注入」本体：pastStateNote を作って meta.extra に入れる
  // =========================================================
  try {
    const topicLabel =
      typeof args.topicLabel === 'string'
        ? args.topicLabel
        : metaForSave?.situation_topic ??
          metaForSave?.situationTopic ??
          metaForSave?.topicLabel ??
          null;

    const limit =
      typeof args.pastStateLimit === 'number' && Number.isFinite(args.pastStateLimit)
        ? args.pastStateLimit
        : 3;

    const forceFallback =
      typeof args.forceRecentTopicFallback === 'boolean'
        ? args.forceRecentTopicFallback
        : true; // ★要件：毎ターン recent_topic fallback

    const recall = await preparePastStateNoteForTurn({
      client: supabase,
      userCode,
      userText,
      topicLabel,
      limit,
      forceRecentTopicFallback: forceFallback,
    });

    metaForSave.extra = metaForSave.extra ?? {};

    // hasNote の時だけ入れる（トークン節約）
    if (recall.hasNote && recall.pastStateNoteText) {
      metaForSave.extra.pastStateNoteText = recall.pastStateNoteText;
      metaForSave.extra.pastStateTriggerKind = recall.triggerKind ?? null;
      metaForSave.extra.pastStateKeyword = recall.keyword ?? null;
    } else {
      metaForSave.extra.pastStateNoteText = null;
      metaForSave.extra.pastStateTriggerKind = recall.triggerKind ?? null;
      metaForSave.extra.pastStateKeyword = recall.keyword ?? null;
    }

    console.log('[IROS/PostProcess] pastStateNote injected', {
      userCode,
      hasNote: recall.hasNote,
      triggerKind: recall.triggerKind,
      keyword: recall.keyword,
      len: recall.pastStateNoteText ? recall.pastStateNoteText.length : 0,
    });
  } catch (e) {
    console.warn('[IROS/PostProcess] pastStateNote inject failed', e);
  }

  return { assistantText, metaForSave };
}
