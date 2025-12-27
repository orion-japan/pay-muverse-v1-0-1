// file: src/lib/iros/orchestratorVisionTrigger.ts
// E) Vision Trigger 判定
// - vision モードへの遷移判定を単独で担当
// - meta を更新して返す（再代入しない / behavior-preserving）

import { detectVisionTrigger } from './visionTrigger';

export type ApplyVisionTriggerArgs = {
  text: string;
  meta: any;
};

export type ApplyVisionTriggerResult = {
  meta: any;
  triggered: boolean;
};

export function applyVisionTrigger(
  args: ApplyVisionTriggerArgs,
): ApplyVisionTriggerResult {
  const { text } = args;

  // ✅ 再代入しない（const meta 問題を回避）
  const baseMeta = args.meta;

  const result = detectVisionTrigger({
    text,
    meta: baseMeta,
  });

  if (result?.triggered) {
    const nextMeta = {
      ...baseMeta,
      ...result.meta,
    };

    return {
      meta: nextMeta,
      triggered: true,
    };
  }

  return {
    meta: baseMeta,
    triggered: false,
  };
}
