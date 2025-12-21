// src/lib/iros/language/planReply.ts
// iros — Reply Plan (器 + スロット)
// - 「中身はメタで決める / 見せ方は器を選ぶ」ための最小型定義
// - renderReply.ts 側の planned renderer が import するだけなので、まずは型を確定させる

/**
 * 器（見せ方）
 * - NONE     : ほぼ装飾しない（挨拶/雑談/説明不要）
 * - PLAIN    : 静かな段落（基本）
 * - HEADING  : 見出しで区切る（整理が必要な時）
 * - NUMBERED : 1,2,3... 自然順（教えて/手順/説得力が欲しい時）
 */
export type ContainerId = 'NONE' | 'PLAIN' | 'HEADING' | 'NUMBERED' | 'BULLET';

/**
 * スロット（置き場）
 * - opener  : 入口（挨拶/存在感/軽い前置き）
 * - facts   : 表層の直答（必須）
 * - mirror  : 芯（刺し / 滲ませ）
 * - elevate : 一段上の俯瞰（Sofiaっぽいが上から語らない）
 * - move    : 次の一歩（0.5未来）
 * - ask     : 確認（問いを「置く」）
 */
export type ReplySlotKey = 'opener' | 'facts' | 'mirror' | 'elevate' | 'move' | 'ask';

/**
 * Plan 本体
 * - containerId: 器
 * - slots: スロット文（facts以外は任意）
 * - debug: デバッグ用途（なぜその器にしたか等）
 */
export type ReplyPlan = {
  containerId: ContainerId;
  slots: Partial<Record<ReplySlotKey, string>>;
  debug?: {
    reason?: string;
    pickedBy?: 'meta' | 'rule' | 'user';
  };
};
