// src/lib/iros/icue/applyICueToSlotPlan.ts
// iros — I-Cue apply (slotPlanに「I-Lineを必ず入れる」を構造で刻む)
//
// 目的：
// - detectICue() が ok=true を返したら、slotPlan（OBS/SHIFT/NEXT/SAFE 等）へ
//   “言い切り1文（iLine）” を必ず混ぜる。
// - ここは「構造で決める」ので、LLMの気分に左右されない。
// - 返した slotPlan は、そのまま effectiveText にシリアライズされる前提。
// - 後段の rephraseEngine では、この iLine を「改変禁止の固定文」として扱う想定（別ファイルで対応）。

import type { ICue } from './orchestratorIcue';

export type SlotLike = {
  key: string; // 'OBS' | 'SHIFT' | 'NEXT' | 'SAFE' など
  role: 'assistant' | 'user';
  style?: string;
  content: string;
};

export type ApplyICueResult = {
  applied: boolean;
  targetKey: string | null;
  slots: SlotLike[];
  note: {
    reason: string;
    iCueKind?: ICue['kind'];
    iLine?: string | null;
  };
};

export type ApplyICueOptions = {
  /**
   * I-Line を差し込みたい優先キー
   * - 会話の自然さ：SHIFT（視点）→ NEXT（次へ）あたりが一番噛み合う
   */
  preferredKeys?: string[];
  /**
   * すでに slotPlan 側に I-Line 相当が入っている場合の再注入を防ぐ
   */
  avoidDuplicate?: boolean;
};

const DEFAULT_KEYS = ['SHIFT', 'NEXT', 'OBS', 'SAFE'] as const;

/**
 * slotPlan へ I-Line を注入する（構造確定）
 * - 方式：対象スロットの content の「先頭」へ 1行差し込む（改行で区切る）
 * - 既存 content は保持（LLMに素材を渡す）
 */
export function applyICueToSlotPlan(
  slots: SlotLike[],
  cue: ICue,
  opts: ApplyICueOptions = {}
): ApplyICueResult {
  if (!cue?.ok || !cue.iLine) {
    return {
      applied: false,
      targetKey: null,
      slots,
      note: { reason: 'cue_not_ok_or_empty' },
    };
  }

  const preferred = (opts.preferredKeys?.length
    ? opts.preferredKeys
    : Array.from(DEFAULT_KEYS)) as string[];

  // すでに含まれているなら（重複回避）
  if (opts.avoidDuplicate !== false) {
    const already = slots.some((s) => norm(s.content).includes(norm(cue.iLine!)));
    if (already) {
      return {
        applied: false,
        targetKey: null,
        slots,
        note: { reason: 'already_contains_iLine', iCueKind: cue.kind, iLine: cue.iLine },
      };
    }
  }

  // 対象スロットを探す（assistantのスロットのみ）
  const idx = pickTargetIndex(slots, preferred);

  if (idx < 0) {
    // どこにも入れられないなら、末尾に1スロット追加（assistant）
    const appended: SlotLike[] = [
      ...slots,
      {
        key: 'SHIFT',
        role: 'assistant',
        style: 'neutral',
        content: cue.iLine,
      },
    ];
    return {
      applied: true,
      targetKey: 'SHIFT',
      slots: appended,
      note: { reason: 'appended_new_slot', iCueKind: cue.kind, iLine: cue.iLine },
    };
  }

  const target = slots[idx];

  // 差し込み：先頭に I-Line を置く（“言い切り”が先に刺さる）
  // ただし既存が空に近い場合もあるので安全に。
  const injected = injectLine(target.content, cue.iLine);

  const nextSlots = slots.map((s, i) =>
    i === idx
      ? {
          ...s,
          content: injected,
        }
      : s
  );

  return {
    applied: true,
    targetKey: target.key,
    slots: nextSlots,
    note: { reason: 'injected', iCueKind: cue.kind, iLine: cue.iLine },
  };
}

function pickTargetIndex(slots: SlotLike[], preferredKeys: string[]): number {
  // 優先キー順に探す
  for (const k of preferredKeys) {
    const idx = slots.findIndex((s) => s.role === 'assistant' && s.key === k);
    if (idx >= 0) return idx;
  }
  // fallback：assistant の最初
  const any = slots.findIndex((s) => s.role === 'assistant');
  return any;
}

function injectLine(original: string, line: string): string {
  const o = normKeepNewlines(original);
  const l = norm(line);
  if (!l) return o;

  if (!o) return l;

  // 先頭に差し込む（1行空ける）
  return `${l}\n${o}`;
}

function norm(s: string): string {
  return (s ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normKeepNewlines(s: string): string {
  return (s ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
