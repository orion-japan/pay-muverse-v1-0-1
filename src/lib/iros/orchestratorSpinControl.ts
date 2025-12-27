// file: src/lib/iros/orchestratorSpinControl.ts
// C) 揺らぎ×ヒステリシス → 回転ギア確定（behavior-preserving）
// - orchestrator.ts の SpinControl ブロックを関数化
// - decideSpinControl / decideAnchorEvent の結果を meta に反映するだけ
// - 重要：meta.intent_anchor.text の扱い、devログ条件も維持

import type { IrosMeta } from './system';
import { decideSpinControl } from './spin/decideSpinControl';
import { decideAnchorEvent } from './intentAnchor/anchorEvent';

export type ApplySpinControlArgs = {
  meta: IrosMeta;
  lastVolatilityRank: 'low' | 'mid' | 'high' | null;
};

export function applySpinControlAndAnchorEvent(
  args: ApplySpinControlArgs,
): IrosMeta {
  const { meta, lastVolatilityRank } = args;

  const spinCtl = decideSpinControl({
    stabilityBand:
      ((meta as any)?.unified?.stabilityBand as any) ??
      ((meta as any)?.stabilityBand as any) ??
      null,

    yLevel: typeof (meta as any).yLevel === 'number' ? (meta as any).yLevel : null,
    hLevel: typeof (meta as any).hLevel === 'number' ? (meta as any).hLevel : null,
    phase: ((meta as any).phase as any) ?? null,
    prevRank: lastVolatilityRank,
  });

  // meta 保存（Writer/MemoryState が読む）
  (meta as any).volatilityRank = spinCtl.rank;              // 'low'|'mid'|'high'
  (meta as any).spinDirection = spinCtl.direction;          // 'forward'|'brake' (相生/相克)
  (meta as any).promptStyle = spinCtl.promptStyle;          // 'one-step'|'two-choice'|'safety-brake'
  (meta as any).shouldConfirmAnchor = spinCtl.shouldConfirmAnchor;

  // ★ High の時だけ：アンカー確認イベントを生成
  const anchorText: string | null =
    (meta as any)?.intent_anchor?.text &&
    typeof (meta as any).intent_anchor.text === 'string' &&
    (meta as any).intent_anchor.text.trim().length > 0
      ? (meta as any).intent_anchor.text.trim()
      : null;

  const anchorEvent = decideAnchorEvent(spinCtl.rank, anchorText);
  (meta as any).anchorEvent = anchorEvent;

  // デバッグ（開発時だけ）
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log('[IROS/SpinControl]', {
      rank: spinCtl.rank,
      direction: spinCtl.direction,
      promptStyle: spinCtl.promptStyle,
      phase: (meta as any).phase,
      anchorEventType: (anchorEvent as any)?.type,
      hysteresis: spinCtl.debug?.hysteresisApplied,
    });
  }

  return meta;
}
