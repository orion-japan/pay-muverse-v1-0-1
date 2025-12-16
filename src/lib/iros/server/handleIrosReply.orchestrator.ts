// file: src/lib/iros/server/handleIrosReply.orchestrator.ts
// iros - Orchestrator wrapper (minimal + anchor safety)

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

  baseMetaForTurn: any;

  userProfile: IrosUserProfileRow | null;
  effectiveStyle: IrosStyle | string | null;
};

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

  // DB行っぽい形なら許可しやすい（id/user_id/created_at 等）
  const looksLikeRow =
    Boolean(a?.id) ||
    Boolean(a?.user_id) ||
    Boolean(a?.created_at) ||
    Boolean(a?.updated_at);

  // set/reset イベントなら許可しやすい
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

  // 2) メタ判定に引っかかる → 捨てる
  if (isMetaAnchorText(text)) {
    delete meta.intentAnchor;
    return meta;
  }

  // 3) Rowでもなく、set/reset でもない → 擬似アンカーとして捨てる
  if (!looksLikeRow && !shouldBeRealEvent) {
    delete meta.intentAnchor;
    return meta;
  }

  return meta;
}

export async function runOrchestratorTurn(
  args: RunOrchestratorTurnArgs
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
    userProfile,
    effectiveStyle,
  } = args;

  // ✅ 入力側：baseMeta の intentAnchor を必ず検疫（ここが一番効く）
  const safeBaseMeta =
    baseMetaForTurn && typeof baseMetaForTurn === 'object'
      ? { ...baseMetaForTurn }
      : {};

  sanitizeIntentAnchor(safeBaseMeta);

  // runIrosTurn 側の引数型に合わせて any で渡す（段階的に厳密化する）
  const result = await runIrosTurn({
    conversationId,
    userCode,
    text,
    isFirstTurn,
    requestedMode: requestedMode as any,
    requestedDepth: requestedDepth as any,
    requestedQCode: requestedQCode as any,
    baseMeta: safeBaseMeta,
    userProfile,
    style: effectiveStyle as any,
  } as any);

  // ✅ 出力側：orchResult.meta も検疫（万一 meta 生成側が汚染しても止血）
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
