// src/lib/iros/slotPlans/normalChat.ts
// iros — normal chat slot plan (FINAL-only, flexible slots)
//
// 目的：
// - normalChat は必ず FINAL を返す（空返答を防ぐ）
// - ただし「スロット数・キー」は固定しない（1〜6で可変）
// - ライトな雑談は“直接短く”返す（分類質問で縛らない）
//
// ルール：
// - slots は「表示順」だけが意味を持つ
// - key は任意文字列でよい（ただし重複はしない）
// - rephrase は inKeys と一致したときだけ採用（既存の検証思想を維持）

import type { SlotPlanPolicy } from '../server/llmGate';

export type NormalChatSlot = {
  key: string; // ✅ 固定しない（任意キー）
  role: 'assistant';
  style: 'neutral' | 'soft' | 'firm';
  content: string;
};

export type NormalChatSlotPlan = {
  kind: 'normal-chat';
  stamp: string;
  reason: string;
  slotPlanPolicy: SlotPlanPolicy; // 'FINAL'
  slots: NormalChatSlot[];
};

// ---- heuristics (small + safe) ----

function norm(s: unknown) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function looksLikePreferenceQuestion(text: string) {
  const t = norm(text);
  // 「好き？」「嫌い？」「どっち派？」などを軽く拾う（厳密にやりすぎない）
  return (
    /好き[？\?]/.test(t) ||
    /嫌い[？\?]/.test(t) ||
    /どっち(派)?[？\?]/.test(t) ||
    /おすすめ[？\?]/.test(t)
  );
}

function buildLightChat(text: string): NormalChatSlot[] {
  const t = norm(text);

  // 例：「ももは好き？」→ 直接答えて、1つだけ軽く広げる
  if (/もも/.test(t) && /好き[？\?]/.test(t)) {
    return [
      {
        key: 'A',
        role: 'assistant',
        style: 'soft',
        content: '好き。香りが強くて、甘さの立ち上がりがきれい。',
      },
      {
        key: 'B',
        role: 'assistant',
        style: 'neutral',
        content: '白桃派？黄桃派？（一語でOK）',
      },
    ];
  }

  // 汎用：好み質問は「短く答える→軽く返す」
  return [
    {
      key: 'A',
      role: 'assistant',
      style: 'soft',
      content: `うん、話は「${t}」だね。`,
    },
    {
      key: 'B',
      role: 'assistant',
      style: 'neutral',
      content: '直球で答えると：好き？嫌い？どっち寄り？',
    },
  ];
}

export function buildNormalChatSlotPlan(args: { userText: string }): NormalChatSlotPlan {
  const userText = norm(args.userText);

  // ✅ 「受け取った」注入は廃止（ここが出力に残る元凶）
  // - OBS は “短い観測” にする
  // - NEXT は “1つだけ確認” で軽く繋ぐ
  const slots: NormalChatSlot[] = looksLikePreferenceQuestion(userText)
    ? [
        {
          key: 'OBS',
          role: 'assistant',
          style: 'neutral',
          content: `うん、「${userText}」の話だね。`,
        },
        {
          key: 'NEXT',
          role: 'assistant',
          style: 'neutral',
          content: 'いま一番ほしいのは、結論？整理？それとも雑談？',
        },
      ]
    : [
        // ✅ 空配列禁止：通常は “短く返す→1つだけ確認”
        {
          key: 'OBS',
          role: 'assistant',
          style: 'soft',
          content: `いま出ている言葉：「${userText}」`,
        },
        {
          key: 'NEXT',
          role: 'assistant',
          style: 'neutral',
          content: '一つだけ確認：いま知りたいのは「結論」？それとも「条件で変わる話」？',
        },
      ];

  console.log('[IROS/normalChat][built]', {
    stamp: 'normalChat.ts@2026-01-10#flex-slots-v1',
    slotsLen: slots.length,
    keys: slots.map((s) => s.key),
    heads: slots.map((s) => String(s.content ?? '').slice(0, 24)),
  });

  return {
    kind: 'normal-chat',
    stamp: 'normalChat.ts@2026-01-10#flex-slots-v1',
    reason: 'normal',
    slotPlanPolicy: 'FINAL',
    slots,
  };
}
