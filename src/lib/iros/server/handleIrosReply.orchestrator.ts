// file: src/lib/iros/server/handleIrosReply.orchestrator.ts
// iros - Orchestrator wrapper
// ✅ 役割：Context で確定した構造（rotationState / framePlan）を
//    そのまま Orchestrator / Writer に届ける
// - intentAnchor だけ検疫
// - 回転やフレームは「触らない・削らない」
// ✅ 追加：history を受け取り、そのまま runIrosTurn に渡す（ITDemoGate 用）

import { runIrosTurn } from '@/lib/iros/orchestrator';
import type { IrosStyle } from '@/lib/iros/system';
import type { IrosUserProfileRow } from './loadUserProfile';
import { isMetaAnchorText } from '@/lib/iros/intentAnchor';

export type RunOrchestratorTurnArgs = {
  conversationId: string;
  userCode: string;
  text: string;

  isFirstTurn: boolean;

  requestedMode: string | undefined;
  requestedDepth: string | undefined;
  requestedQCode: string | undefined;

  /** ✅ Context で確定した唯一の基礎メタ */
  baseMetaForTurn: any;

  /** ✅ NEW: ITDemoGate / repeat 判定用の履歴（handleIrosReply 側から渡す） */
  history?: unknown[];

  userProfile: IrosUserProfileRow | null;
  effectiveStyle: IrosStyle | string | null;
};

/* =========================
   intentAnchor sanitize（最小）
========================= */

function pickIntentAnchorText(meta: any): string {
  const a = meta?.intentAnchor;
  const t =
    (a?.anchor_text ?? '') ||
    (a?.anchorText ?? '') ||
    (a?.text ?? '') ||
    '';
  return String(t);
}

function sanitizeIntentAnchor(meta: any): any {
  if (!meta || typeof meta !== 'object') return meta;
  if (!meta.intentAnchor) return meta;

  const text = pickIntentAnchorText(meta);
  const hasText = Boolean(text && text.trim());

  const a = meta.intentAnchor;

  // DB 行っぽい形なら許可
  const looksLikeRow =
    Boolean(a?.id) ||
    Boolean(a?.user_id) ||
    Boolean(a?.created_at) ||
    Boolean(a?.updated_at);

  // set/reset イベントなら許可
  const ev: string | null =
    meta.anchorEventType ??
    meta.intentAnchorEventType ??
    meta.anchor_event_type ??
    meta.intent_anchor_event_type ??
    null;

  const shouldBeRealEvent = ev === 'set' || ev === 'reset';

  // 1) テキストが無い → 捨てる
  if (!hasText) {
    delete meta.intentAnchor;
    return meta;
  }

  // 2) メタ文言 → 捨てる
  if (isMetaAnchorText(text)) {
    delete meta.intentAnchor;
    return meta;
  }

  // 3) Row でも event でもない → 捨てる
  if (!looksLikeRow && !shouldBeRealEvent) {
    delete meta.intentAnchor;
    return meta;
  }

  return meta;
}

/* =========================
   main
========================= */

export async function runOrchestratorTurn(
  args: RunOrchestratorTurnArgs,
): Promise<any> {
  const {
    conversationId,
    userCode,
    text,
    isFirstTurn,
    requestedMode,
    requestedDepth,
    requestedQCode,
    baseMetaForTurn,
    history, // ✅ 追加
    userProfile,
    effectiveStyle,
  } = args;

  // =========================================================
  // ✅ 入力メタ：Context で確定した構造をそのまま使う
  // - top は shallow copy
  // - rotationState / framePlan / intentAnchor は参照共有を切る（破壊的更新対策）
  // - intentAnchor 以外は触らない（= 値は変えず、clone だけ）
  // =========================================================
  const safeBaseMeta =
    baseMetaForTurn && typeof baseMetaForTurn === 'object'
      ? { ...baseMetaForTurn }
      : {};

  // ✅ 参照共有を切る（Context確定値を汚さないため）
  if (
    safeBaseMeta.rotationState &&
    typeof safeBaseMeta.rotationState === 'object'
  ) {
    safeBaseMeta.rotationState = { ...safeBaseMeta.rotationState };
  }
  if (safeBaseMeta.framePlan && typeof safeBaseMeta.framePlan === 'object') {
    safeBaseMeta.framePlan = { ...safeBaseMeta.framePlan };
  }
  if (safeBaseMeta.intentAnchor && typeof safeBaseMeta.intentAnchor === 'object') {
    safeBaseMeta.intentAnchor = { ...safeBaseMeta.intentAnchor };
  }

  // intentAnchor だけ検疫（回転・framePlan は絶対に触らない）
  sanitizeIntentAnchor(safeBaseMeta);

  // デバッグ（必要最低限）
  console.log('[IROS/Orchestrator] input meta snapshot', {
    hasRotationState: Boolean(safeBaseMeta.rotationState),
    spinLoop: safeBaseMeta.rotationState?.spinLoop ?? safeBaseMeta.spinLoop ?? null,
    descentGate:
      safeBaseMeta.rotationState?.descentGate ?? safeBaseMeta.descentGate ?? null,
    depth: safeBaseMeta.rotationState?.depth ?? safeBaseMeta.depth ?? null,
    frame: safeBaseMeta.framePlan?.frame ?? null,
    historyLen: Array.isArray(history) ? history.length : 0, // ✅ 追加
  });

  // =========================================================
  // runIrosTurn
  // - requestedDepth / QCode は “補助”
  // - 実質の判断は baseMeta（rotationState / framePlan）
  // =========================================================
  const result = await runIrosTurn({
    conversationId,
    userCode,
    text,
    isFirstTurn,

    requestedMode: requestedMode as any,
    requestedDepth: requestedDepth as any,
    requestedQCode: requestedQCode as any,

    baseMeta: safeBaseMeta,

    // ✅ NEW: 履歴をそのまま Orchestrator → generate → ITDemoGate へ届ける
    history: Array.isArray(history) ? history : [],

    userProfile,
    style: effectiveStyle as any,
  } as any);

  // =========================================================
  // ✅ 出力メタ：intentAnchor だけ再検疫
  // - rotationState / framePlan は保持
  // =========================================================
  try {
    if (result && typeof result === 'object') {
      const r: any = result;
      if (r.meta && typeof r.meta === 'object') {
        r.meta = { ...r.meta };
        sanitizeIntentAnchor(r.meta);
      }
    }
  } catch (e) {
    console.warn('[IROS/Orchestrator] output sanitize failed', e);
  }

  return result;
}
