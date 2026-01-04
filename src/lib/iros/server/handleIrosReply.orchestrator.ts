// file: src/lib/iros/server/handleIrosReply.orchestrator.ts
// iros - Orchestrator wrapper (MIN)
// ✅ 役割：Context で確定した baseMeta を「壊さずに」runIrosTurn へ渡す
// - rotationState / framePlan は値を変えない（clone だけ）
// - intentAnchor だけ検疫（メタ文言・偽アンカーの混入を防ぐ）
// - history をそのまま runIrosTurn に渡す（ITDemoGate / repeat 判定用）

import type { SupabaseClient } from '@supabase/supabase-js';

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

  /** ✅ ITDemoGate / repeat 判定用の履歴（handleIrosReply 側から渡す） */
  history?: unknown[];

  /** ✅ MemoryState 読み書き用の Supabase admin client */
  sb: SupabaseClient;

  userProfile: IrosUserProfileRow | null;
  effectiveStyle: IrosStyle | string | null;
};

/* =========================
   intentAnchor sanitize（最小）
   - テキストが無い/メタ文言/偽アンカー → intentAnchor を落とす
   - Rowっぽい形 or set/reset イベントなら許可
========================= */

function pickAnchorText(intentAnchor: any): string {
  if (!intentAnchor) return '';
  if (typeof intentAnchor === 'string') return intentAnchor;
  if (typeof intentAnchor === 'object') {
    return (
      String(
        intentAnchor.anchor_text ??
          intentAnchor.anchorText ??
          intentAnchor.text ??
          '',
      ) || ''
    );
  }
  return '';
}

function pickAnchorEvent(meta: any): string | null {
  const ev =
    meta?.anchorEventType ??
    meta?.intentAnchorEventType ??
    meta?.anchor_event_type ??
    meta?.intent_anchor_event_type ??
    meta?.anchorEvent?.type ??
    null;
  return typeof ev === 'string' ? ev.trim().toLowerCase() : null;
}

function looksLikeDbRow(a: any): boolean {
  if (!a || typeof a !== 'object') return false;
  return Boolean(a.id || a.user_id || a.created_at || a.updated_at);
}

function sanitizeIntentAnchor(meta: any): void {
  if (!meta || typeof meta !== 'object') return;
  if (!meta.intentAnchor) return;

  const a = meta.intentAnchor;
  const text = pickAnchorText(a).trim();

  // 1) テキストが無い → 捨てる
  if (!text) {
    delete meta.intentAnchor;
    return;
  }

  // 2) メタ文言 → 捨てる
  if (isMetaAnchorText(text)) {
    delete meta.intentAnchor;
    return;
  }

  // 3) Row でも event(set/reset) でもない → 捨てる
  const ev = pickAnchorEvent(meta);
  const isRealEvent = ev === 'set' || ev === 'reset';
  if (!looksLikeDbRow(a) && !isRealEvent) {
    delete meta.intentAnchor;
    return;
  }
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
    history,
    sb,
    userProfile,
    effectiveStyle,
  } = args;

  // =========================================================
  // ✅ baseMeta を壊さない
  // - top は shallow copy
  // - rotationState / framePlan / intentAnchor は shallow clone（参照共有切り）
  // - 値の変更は intentAnchor の削除のみ
  // =========================================================
  const safeBaseMeta =
    baseMetaForTurn && typeof baseMetaForTurn === 'object'
      ? { ...baseMetaForTurn }
      : {};

  if (safeBaseMeta.rotationState && typeof safeBaseMeta.rotationState === 'object') {
    safeBaseMeta.rotationState = { ...safeBaseMeta.rotationState };
  }
  if (safeBaseMeta.framePlan && typeof safeBaseMeta.framePlan === 'object') {
    safeBaseMeta.framePlan = { ...safeBaseMeta.framePlan };
  }
  if (safeBaseMeta.intentAnchor && typeof safeBaseMeta.intentAnchor === 'object') {
    safeBaseMeta.intentAnchor = { ...safeBaseMeta.intentAnchor };
  }

  // intentAnchor だけ検疫（rotationState / framePlan は絶対に触らない）
  sanitizeIntentAnchor(safeBaseMeta);

  console.log('[IROS/Orchestrator] input meta snapshot', {
    hasRotationState: Boolean(safeBaseMeta.rotationState),
    spinLoop: safeBaseMeta.rotationState?.spinLoop ?? safeBaseMeta.spinLoop ?? null,
    descentGate: safeBaseMeta.rotationState?.descentGate ?? safeBaseMeta.descentGate ?? null,
    depth: safeBaseMeta.rotationState?.depth ?? safeBaseMeta.depth ?? null,
    frame: safeBaseMeta.framePlan?.frame ?? null,
    historyLen: Array.isArray(history) ? history.length : 0,
    hasIntentAnchor: Boolean(safeBaseMeta.intentAnchor),
  });

  // =========================================================
  // ✅ そのまま Orchestrator へ
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

    sb,
    history: Array.isArray(history) ? history : [],
    userProfile,
    style: effectiveStyle as any,
  } as any);

  // =========================================================
  // ✅ 出力側も最小の安全策（intentAnchor だけ落とす）
  // ※ output meta を信じない運用でも、混入事故をゼロにするため残す
  // =========================================================
  try {
    if (result && typeof result === 'object') {
      const r: any = result;
      if (r.meta && typeof r.meta === 'object') {
        r.meta = { ...r.meta };
        sanitizeIntentAnchor(r.meta);
      }
    }
  } catch {}

  return result;
}
