// src/lib/iros/personalContext.ts
// 「orion固有」の文脈を、Soul の情報から LLM 向けテキストとして組み立てるヘルパー。
// UI には直接出さず、system プロンプトの下層などに静かに差し込む想定。

import type { SoulReplyContext, SoulNoteLike } from '@/lib/iros/soul/composeSoulReply';
import {
  decidePersonalIntensityFromSoul,
  type PersonalIntensity,
} from '@/lib/iros/soul/composeSoulReply';

// 必要に応じて拡張してOK
export type PersonalContextInput = {
  soulCtx: SoulReplyContext;
  // ここに将来 topic や futureSeed などを足していける
  topicLabel?: string | null;
};

export type PersonalContextResult = {
  intensity: PersonalIntensity;
  text: string | null; // null のときはプロンプトに差し込まない
};

/**
 * Soul の情報と「揺らぎ」に同期した orion固有コンテキストを組み立てる。
 *
 * 仕様：
 * - intensity は composeSoulReply 側の decidePersonalIntensityFromSoul と完全同期
 * - none   : text は null（→ 何も差し込まない）
 * - light  : core_need を中心に 1〜2行だけ
 * - strong : core_need / soul_sentence / step_phrase を含めて、やや濃いめに
 */
export function buildPersonalContextFromSoul(input: PersonalContextInput): PersonalContextResult {
  const { soulCtx, topicLabel } = input;
  const soulNote = soulCtx.soulNote as SoulNoteLike | null;

  const intensity = decidePersonalIntensityFromSoul(soulCtx);

  if (!soulNote || intensity === 'none') {
    return { intensity, text: null };
  }

  const lines: string[] = [];

  const coreNeed = soulNote.core_need?.trim();
  const step = soulNote.step_phrase?.trim();
  const soulSent = soulNote.soul_sentence?.trim();

  // 0) ユーザー固有のテーマ（あれば）
  if (topicLabel) {
    lines.push(`● いま主に扱っているテーマ：${topicLabel}`);
  }

  // 1) light / strong 共通：core_need を「この人の核」として LLM に伝える
  if (coreNeed) {
    lines.push(`● このユーザーの核となる願い：${coreNeed}`);
  }

  if (intensity === 'strong') {
    // 2) strong のときだけ、もう少し深い情報を渡す

    if (soulSent) {
      lines.push(`● 魂レベルでの一文（要約）：${soulSent}`);
    }

    if (step) {
      lines.push(`● いま響かせたい一歩の方向性：${step}`);
    }

    // Q5リスクなどは composeSoulReply 側で tone / 表現が安全寄りに制御されている想定。
    // ここでは「煽らない」「断定しない」情報だけを置いておく。
  }

  if (lines.length === 0) {
    return { intensity, text: null };
  }

  const text =
    [
      '【このユーザー固有の文脈メモ】',
      ...lines,
      'これらは UI には直接出さず、言葉の選び方や比喩・方向性に静かに反映するだけにとどめること。',
    ].join('\n');

  return { intensity, text };
}
