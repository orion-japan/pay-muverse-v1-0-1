// src/lib/iros/soul/composeSoulReply.ts
// Soul failsafe 専用
// - 通常の文章生成には参加しない
// - 3軸（Q / Depth / Phase）が欠損・不整合などで iros_pure が安全に動けない時だけ呼ばれる
// - 返すのは「安全な最小文」だけ（共感語り・願い翻訳・比喩・一手提案・個性付与はしない）

export type SoulNoteLike = {
  // 互換のため型は残すが、failsafe では使用しない
  core_need?: string | null;
  step_phrase?: string | null;
  soul_sentence?: string | null;
  tone_hint?: string | null;
  risk_flags?: string[] | null;
  notes?: string | null;
};

export type SoulReplyContext = {
  userText: string;
  qCode?: string | null;
  depthStage?: string | null;
  styleHint?: string | null;
  soulNote?: SoulNoteLike | null;
};

/**
 * failsafe の最小返信
 * - 余計な判断をしない
 * - 行動を煽らない
 * - ここに「戻せる導線」だけ置く
 */
export function composeSoulReply(ctx: SoulReplyContext): string {
  const short = trimToOneLine(ctx.userText);

  // userText が取れているなら引用して「受領」だけ返す（分析しない）
  if (short) {
    return [
      '受け取りました。',
      `「${short}」という入力が来ています。`,
      'いまは内部状態（Q / Depth / Phase）が不安定なので、まず状況を1行だけ補足してください。',
    ].join('\n');
  }

  // userText が空に近い場合
  return [
    '受け取りました。',
    'いまは内部状態（Q / Depth / Phase）が不安定なので、状況を1行だけ書いてください。',
  ].join('\n');
}

/* ========= 内部ヘルパー ========= */

function trimToOneLine(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}
/* =========================================================
   Personal intensity (compat exports)
   - 以前 personalContext.ts から参照されていた互換用
   - Soul failsafe 方針により、現状は常に "none" を返す
========================================================= */

export type PersonalIntensity = 'none' | 'light' | 'medium' | 'high';

/**
 * 互換関数（personalContext から呼ばれても安全に動く）
 * 現行の Soul は failsafe 専用のため、強度は上げない。
 */
export function decidePersonalIntensityFromSoul(
  _soulNote: SoulNoteLike | null | undefined,
): PersonalIntensity {
  return 'none';
}
