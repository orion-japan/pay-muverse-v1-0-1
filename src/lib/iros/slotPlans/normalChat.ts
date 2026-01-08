// src/lib/iros/slotPlans/normalChat.ts
// iros — normal chat slot plan (FINAL-only)
//
// 目的：
// - 通常会話（normalChat）は必ず FINAL を返す（実装強制）
// - SCAFFOLD は emergency / silence / special fallback 専用
// - 「編集したファイルが本当に読まれているか」をログで証明する
//
// ⚠️ 重要
// - normalChat では例外条件を一切持たない
// - 例外は orchestrator 側で normalChat を選ばないことで表現する

import type { SlotPlanPolicy } from '../server/llmGate';

export type NormalChatSlot = {
  key: 'OBS' | 'SHIFT' | 'NEXT' | 'SAFE';
  role: 'assistant';
  style: 'neutral' | 'soft' | 'firm';
  content: string;
};

export type NormalChatSlotPlan = {
  kind: 'normal-chat';
  slotPlanPolicy: SlotPlanPolicy;
  slots: NormalChatSlot[];
};

// ✅ 実行時の照合用（ログに必ず出る）
const NORMAL_CHAT_BUILD_STAMP = 'normalChat.ts@2026-01-06#FINAL';

// ✅ 実装強制：normalChat は常に FINAL（例外なし）
const NORMAL_CHAT_POLICY: SlotPlanPolicy = 'FINAL';

const norm = (s: unknown) =>
  String(s ?? '').replace(/\s+/g, ' ').trim();

function assertFinal(p: unknown): asserts p is 'FINAL' {
  if (p !== 'FINAL') {
    throw new Error(
      `[normalChat] slotPlanPolicy must be FINAL, got: ${String(p)}`
    );
  }
}

export function buildNormalChatSlotPlan(args: {
  userText: string;
}): NormalChatSlotPlan {
  const fact = norm(args.userText);

  const obs = `受け取った。🪔\nいま出ている言葉：「${fact}」`;
  const shift = `いまの一番大事な一点だけ、残す。`;
  const next = `次は、行動を一手に落とす（誰に／いつ／何を）。`;
  const safe = `迷いを増やさない。`;

  const slots: NormalChatSlot[] = [
    { key: 'OBS', role: 'assistant', style: 'neutral', content: obs },
    { key: 'SHIFT', role: 'assistant', style: 'soft', content: shift },
    { key: 'NEXT', role: 'assistant', style: 'firm', content: next },
    { key: 'SAFE', role: 'assistant', style: 'soft', content: safe },
  ];

  // ✅ FINAL 固定
  const slotPlanPolicy: SlotPlanPolicy = NORMAL_CHAT_POLICY;
  assertFinal(slotPlanPolicy);

  // ✅ このファイルが確実に使われていることをログで証明
  console.debug('[normalChat] built slotPlan', {
    stamp: NORMAL_CHAT_BUILD_STAMP,
    reason: 'normal',
    slotPlanPolicy,
    slotsLen: slots.length,
    slotsPreview: slots.map(s => ({
      key: s.key,
      len: String(s.content ?? '').length,
      head: String(s.content ?? '').slice(0, 24),
    })),
    hasEmptyContent: slots.some(
      s => !String(s.content ?? '').trim()
    ),
    factHead: fact,
  });

  return {
    kind: 'normal-chat',
    slotPlanPolicy,
    slots,
  };
}
