// file: src/lib/iros/server/handleIrosReply.orchestrator.ts
// iros - Orchestrator wrapper (MIN)
// ✅ 役割：Context で確定した baseMeta を「壊さずに」runIrosTurn へ渡す
// - rotationState / framePlan は値を変えない（clone だけ）
// - intentAnchor だけ検疫（メタ文言・偽アンカーの混入を防ぐ）
// - history をそのまま runIrosTurn に渡す（ITDemoGate / repeat 判定用）

import type { SupabaseClient } from '@supabase/supabase-js';

import { runIrosTurn } from '@/lib/iros/orchestrator';
import type { IrosStyle } from '@/lib/iros/system';
import { isMetaAnchorText } from '@/lib/iros/intentAnchor';
import type { IrosUserProfileRow } from './loadUserProfile';
import { detectIrTrigger } from '@/lib/iros/orchestratorPierce';

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
   intentAnchor sanitize（最小・Phase11対応）
   - メタ文言/偽アンカー → intentAnchor を落とす
   - ただし固定アンカーキー（例: 'SUN'）は許可（key-only を保持）
   - meta.intentAnchor と meta.intent_anchor の両方を検疫・同期する
========================= */

function isKeyOnlyAnchorText(s: string): boolean {
  // ✅ 固定キー想定：短い / 空白なし / 記号少なめ
  // 'SUN' / 'NORTH_STAR' / 'ANCHOR_01' などを許可
  const t = String(s ?? '').trim();
  if (!t) return false;
  if (t.length < 2 || t.length > 24) return false;
  if (/\s/.test(t)) return false;
  return /^[A-Za-z0-9_-]+$/.test(t);
}

function pickAnchorText(intentAnchor: any): string {
  if (!intentAnchor) return '';
  if (typeof intentAnchor === 'string') return intentAnchor;
  if (typeof intentAnchor === 'object') {
    return String(
      intentAnchor.anchor_text ??
        intentAnchor.anchorText ??
        intentAnchor.text ??
        intentAnchor.key ?? // ✅ key-only も拾う
        '',
    );
  }
  return '';
}

function pickAnchorKey(intentAnchor: any): string | null {
  if (!intentAnchor) return null;
  if (typeof intentAnchor === 'string') return intentAnchor.trim() || null;
  if (typeof intentAnchor === 'object') {
    const k = intentAnchor.key ?? intentAnchor.anchor_key ?? intentAnchor.anchorKey ?? null;
    return typeof k === 'string' ? k.trim() || null : null;
  }
  return null;
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

function sanitizeOneIntentAnchor(meta: any, field: 'intentAnchor' | 'intent_anchor'): void {
  if (!meta || typeof meta !== 'object') return;
  if (!meta[field]) return;

  const a = meta[field];
  const text = pickAnchorText(a).trim();
  const key = pickAnchorKey(a);

  // 1) 空 → 捨てる
  if (!text && !key) {
    delete meta[field];
    return;
  }

  // 2) メタ文言っぽい文章 → 捨てる（※ key-only も含む）
  //    ただし 'SUN' のような短いキーのみは許可
  if (text && isMetaAnchorText(text) && !isKeyOnlyAnchorText(text)) {
    delete meta[field];
    return;
  }

  // 3) key-only を許可（最重要：'SUN' を落とさない）
  if (key && isKeyOnlyAnchorText(key)) {
    return;
  }
  if (text && isKeyOnlyAnchorText(text)) {
    return;
  }

  // 4) Row でも event(set/reset) でもない → 捨てる
  const ev = pickAnchorEvent(meta);
  const isRealEvent = ev === 'set' || ev === 'reset';
  if (!looksLikeDbRow(a) && !isRealEvent) {
    delete meta[field];
    return;
  }
}

function sanitizeIntentAnchor(meta: any): void {
  if (!meta || typeof meta !== 'object') return;

  // 両方検疫
  sanitizeOneIntentAnchor(meta, 'intentAnchor');
  sanitizeOneIntentAnchor(meta, 'intent_anchor');

  // 両方同期（残ってる方を採用）
  const ia =
    meta.intentAnchor ??
    meta.intent_anchor ??
    null;

  meta.intentAnchor = ia;
  meta.intent_anchor = ia;

  // key も同期（下流互換）
  const key =
    meta.intent_anchor_key ??
    (typeof ia === 'string' ? ia : ia?.key ?? null);

  meta.intent_anchor_key = typeof key === 'string' && key.trim() ? key.trim() : null;
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
  // - 値の変更は intentAnchor の削除（検疫）とキー同期のみ
  // - framePlan は “明示コピー（frame/slots/slotPlanPolicy）” で絶対に壊さない
  // =========================================================
  const safeBaseMeta =
    baseMetaForTurn && typeof baseMetaForTurn === 'object'
      ? { ...(baseMetaForTurn as any) }
      : ({} as any);

  // rotationState：浅いコピーで参照共有を切る
  if (safeBaseMeta.rotationState && typeof safeBaseMeta.rotationState === 'object') {
    safeBaseMeta.rotationState = { ...(safeBaseMeta.rotationState as any) };
  }

  // framePlan：render-v2 の唯一の正なので “明示コピー”
  // - slots は配列のまま保持（Record には潰さない）
  // - 参照共有を切るため slots 配列だけ slice() する
  if (safeBaseMeta.framePlan && typeof safeBaseMeta.framePlan === 'object') {
    const fp = safeBaseMeta.framePlan as any;

    const slotsRaw = fp.slots ?? null;
    const slotsArr = Array.isArray(slotsRaw) ? slotsRaw.slice() : null;

    safeBaseMeta.framePlan = {
      frame: fp.frame ?? null,
      slots: slotsArr, // ✅ 配列
      slotPlanPolicy: fp.slotPlanPolicy ?? null,
    };
  }

  // intentAnchor：浅いコピーで参照共有を切る（ここだけ検疫対象）
  if (safeBaseMeta.intentAnchor && typeof safeBaseMeta.intentAnchor === 'object') {
    safeBaseMeta.intentAnchor = { ...(safeBaseMeta.intentAnchor as any) };
  }
  if (safeBaseMeta.intent_anchor && typeof safeBaseMeta.intent_anchor === 'object') {
    safeBaseMeta.intent_anchor = { ...(safeBaseMeta.intent_anchor as any) };
  }

 // =========================================================
// ✅ ir診断：テキストでトリガー検知 → meta に “診断線路” を刻む
// - orchestrator.ts は meta.isIrDiagnosisTurn を見て ir-diagnosis 分岐に入る
// - render 側は meta.presentationKind / meta.mode / meta.extra.* を参照できる
// =========================================================
const irTriggeredNow = detectIrTrigger(text);
const isDiagnosisMode = String(requestedMode ?? '').toLowerCase() === 'diagnosis';

if (irTriggeredNow || isDiagnosisMode) {
  // ✅ これが “線路” ：orchestrator.ts の isIrDiagnosisTurn 判定を確実に ON
  (safeBaseMeta as any).isIrDiagnosisTurn = true;

  // ✅ mode も diagnosis に寄せる（applyModeToMeta が prev を継承するため）
  // ※ ir 起動時だけなので副作用を限定できる
  (safeBaseMeta as any).mode = 'diagnosis';

  // 既存互換（表示ヒント）
  (safeBaseMeta as any).presentationKind = 'diagnosis';
  (safeBaseMeta as any).irTriggered = true;

  const ex0 =
    (safeBaseMeta as any).extra && typeof (safeBaseMeta as any).extra === 'object'
      ? (safeBaseMeta as any).extra
      : {};

  (safeBaseMeta as any).extra = {
    ...ex0,
    irTriggered: true,
    isIrDiagnosisTurn: true,
    presentationKind: 'diagnosis',
    // ✅ renderGateway.ts の looksLikeIR が拾えるヒント（本文依存にしない保険）
    modeHint: 'IR',
  };
}



  console.log('[IROS/Orchestrator] input meta snapshot', {
    hasRotationState: Boolean(safeBaseMeta.rotationState),
    spinLoop: safeBaseMeta.rotationState?.spinLoop ?? safeBaseMeta.spinLoop ?? null,
    descentGate:
      safeBaseMeta.rotationState?.descentGate ?? safeBaseMeta.descentGate ?? null,
    depth: safeBaseMeta.rotationState?.depth ?? safeBaseMeta.depth ?? null,
    frame: safeBaseMeta.framePlan?.frame ?? null,
    slotPlanLen: Array.isArray(safeBaseMeta.framePlan?.slots)
      ? safeBaseMeta.framePlan.slots.length
      : null,
    slotPlanPolicy: safeBaseMeta.framePlan?.slotPlanPolicy ?? null,
    historyLen: Array.isArray(history) ? history.length : 0,
    hasIntentAnchor: Boolean(safeBaseMeta.intentAnchor ?? safeBaseMeta.intent_anchor ?? null),
    intentAnchorKey: (safeBaseMeta as any)?.intent_anchor_key ?? null,
    isIrDiagnosisTurn: (safeBaseMeta as any).isIrDiagnosisTurn ?? null,
mode: (safeBaseMeta as any).mode ?? null,

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
