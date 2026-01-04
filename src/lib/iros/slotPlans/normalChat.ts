// src/lib/iros/slotPlans/normalChat.ts
// 通常会話（非SILENCE / 非IT / 非IR）専用 slotPlan
// 目的：render-v2 に「空でない構造」を必ず渡す（かつ GPTっぽくしない）
//
// ✅ v2確定：normalChat は“床”
// - LLMは使わない
// - 常に空にならないslotPlanを返す
// - Sofiaっぽい気配（短詩1行）は「条件付き・最大1行」だけ許可（任意）

type SlotStyle = 'neutral' | 'soft' | 'firm' | 'poetic';
type Slot = {
  key: string;
  role: 'assistant';
  style: SlotStyle;
  content: string;
};

// src/lib/iros/slotPlans/normalChat.ts
// 通常会話（非SILENCE / 非IT / 非IR）専用 slotPlan
// 目的：render-v2 に「空でない構造」を必ず渡す（かつ GPTっぽくしない）
// ✅ v2方針：ここは “最終本文” ではなく「足場（SCAFFOLD）」
//            LLMが通るなら、後段で sofi a語りに置換してよい。

function normalizeOneLine(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function looksLikeGreeting(t: string): boolean {
  const s = normalizeOneLine(t).toLowerCase();
  return (
    s === 'こんにちは' ||
    s === 'こんばんは' ||
    s === 'おはよう' ||
    s.includes('はじめまして') ||
    s.includes('よろしく')
  );
}

function looksLikeInfoShare(t: string): boolean {
  const s = normalizeOneLine(t);
  return /^今日は/.test(s) || /^いま/.test(s) || s.includes('です');
}

export type NormalChatSlotPlan = {
  kind: 'normal-chat';
  slots: Array<{
    key: string;
    role: 'assistant';
    style: 'neutral' | 'soft';
    content: string;
  }>;

  // ✅ 重要：normal-chat は足場（本文があっても LLM で置換可能）
  slotPlanPolicy: 'SCAFFOLD';
};

export function buildNormalChatSlotPlan(args: { userText: string }): NormalChatSlotPlan {
  const userText = normalizeOneLine(args.userText);

  // ===== LOG: entry =====
  console.debug('[normalChat] enter', {
    userText,
    len: userText.length,
  });

  let core = '了解。🪔';
  let add = '';
  let reason = 'default';

  if (looksLikeGreeting(userText)) {
    core = 'こんにちは、orionさん。🪔';
    add = 'ここはふつうに話して大丈夫です。';
    reason = 'greeting';
  } else if (looksLikeInfoShare(userText)) {
    core = 'うん、届ろきました。🪔';
    add = 'そのまま一言だけ続けてくれたら、流れを整えます。';
    reason = 'info-share';
  } else if (userText.length <= 8) {
    core = '了解。🪔';
    add = '続き、短くでいい。';
    reason = 'short-text';
  } else {
    core = '受け取った。🪔';
    add = 'いまの一番大事な一点だけ、残して進めます。';
    reason = 'normal';
  }

  const slots: NormalChatSlotPlan['slots'] = [
    {
      key: 'core',
      role: 'assistant',
      style: 'neutral',
      content: core,
    },
    {
      key: 'add',
      role: 'assistant',
      style: 'soft',
      content: add,
    },
  ];

  // ===== LOG: before return =====
  console.debug('[normalChat] built slotPlan', {
    reason,
    slotPlanPolicy: 'SCAFFOLD',
    slotsLen: slots.length,
    slotsPreview: slots.map((s) => ({
      key: s.key,
      len: String(s.content ?? '').length,
      head: String(s.content ?? '').slice(0, 20),
    })),
    hasEmptyContent: slots.some((s) => !String(s.content ?? '').trim()),
  });

  return {
    kind: 'normal-chat',
    slotPlanPolicy: 'SCAFFOLD',
    slots,
  };
}

