// file: src/lib/iros/orchestratorSpinControl.ts

import type { IrosMeta } from '@/lib/iros/system';
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

  // ✅ 旗印：二択誘導を全モードで殺す（萎えポイントの根）
  // - decideSpinControl の挙動は温存（rank/direction 等はそのまま）
  // - promptStyle だけ “two-choice → one-step” に正規化して meta に刻む
  const normalizedPromptStyle =
    spinCtl.promptStyle === 'two-choice' ? 'one-step' : spinCtl.promptStyle;

  // meta 保存（Writer/MemoryState が読む）
  (meta as any).volatilityRank = spinCtl.rank;              // 'low'|'mid'|'high'
  (meta as any).spinDirection = spinCtl.direction;          // 'forward'|'brake'
  (meta as any).promptStyle = normalizedPromptStyle;        // 'one-step'|'safety-brake'
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
      promptStyle: normalizedPromptStyle,
      promptStyle_raw: spinCtl.promptStyle, // ← raw も残す（追跡用）
      phase: (meta as any).phase,
      anchorEventType: (anchorEvent as any)?.type,
      hysteresis: spinCtl.debug?.hysteresisApplied,
    });
  }

  return meta;
}
