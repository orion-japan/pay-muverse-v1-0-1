// src/lib/iros/slotPlans/normalChat.ts
// iros — normal chat slot plan (FINAL-only, flow-first, sofia-aligned)
//
// 設計原則（最重要）
// - 意味を決めない
// - 問題を特定しない
// - 正解を出さない
// - 「流れ」だけを壊さない
//
// slotPlan は文章を書かない
// → writer が毎回生成する前提で「構造メタ」だけを渡す

import type { SlotPlanPolicy } from '../server/llmGate';
import { observeFlow } from '../input/flowObserver';

// --------------------------------------------------
// types
// --------------------------------------------------

export type NormalChatSlot = {
  key: string;
  slotId?: string;
  role: 'assistant';
  style: 'neutral' | 'soft';
  content: string; // writer 向けメタ
};

export type NormalChatSlotPlan = {
  kind: 'normal-chat';
  stamp: string;
  reason: string;
  slotPlanPolicy: SlotPlanPolicy;
  slots: NormalChatSlot[];
};

// --------------------------------------------------
// helpers
// --------------------------------------------------

function norm(s: unknown) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function clamp(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

// writer に渡す最小メタ
function m(tag: string, payload?: Record<string, unknown>) {
  if (!payload || Object.keys(payload).length === 0) return `@${tag}`;
  try {
    return `@${tag} ${JSON.stringify(payload)}`;
  } catch {
    return `@${tag}`;
  }
}

function normalizeSlots(slots: NormalChatSlot[]): NormalChatSlot[] {
  let i = 0;
  return (Array.isArray(slots) ? slots : []).map((s) => ({
    ...s,
    slotId: s.slotId ?? `N${++i}`,
  }));
}

// --------------------------------------------------
// minimal detectors（意味判定はしない）
// --------------------------------------------------

function isEnd(text: string) {
  const t = norm(text);
  return t === 'ここまで' || t === '以上' || t.includes('今日はここまで');
}

function isCompose(text: string) {
  const t = norm(text);
  return /(文章|文面|例文|文を作って|書いて|まとめて)/.test(t);
}

// --------------------------------------------------
// slot builders（超最小）
// --------------------------------------------------

function buildEmpty(): NormalChatSlot[] {
  return [{ key: 'EMPTY', role: 'assistant', style: 'soft', content: m('EMPTY') }];
}

function buildEnd(): NormalChatSlot[] {
  return [
    { key: 'END', role: 'assistant', style: 'soft', content: m('END') },
    { key: 'NEXT', role: 'assistant', style: 'neutral', content: m('NEXT', { reopen: true }) },
  ];
}

function buildCompose(userText: string): NormalChatSlot[] {
  const t = norm(userText);
  return [
    {
      key: 'TASK',
      role: 'assistant',
      style: 'neutral',
      content: m('TASK', { kind: 'compose', user: clamp(t, 240) }),
    },
    {
      key: 'DRAFT',
      role: 'assistant',
      style: 'soft',
      content: m('DRAFT', {
        rules: {
          no_advice: true,
          no_summary: true,
          no_checklist: true,
          questions_max: 1,
        },
      }),
    },
  ];
}

function buildFlowReply(
  userText: string,
  flow: { delta: string; confidence?: number } | null
): NormalChatSlot[] {
  const t = norm(userText);
  const delta = flow?.delta ? String(flow.delta) : 'FORWARD';
  const conf = typeof flow?.confidence === 'number' ? flow!.confidence : undefined;

  return [
    {
      key: 'OBS',
      role: 'assistant',
      style: 'soft',
      content: m('OBS', {
        user: clamp(t, 200),
        flow: delta,
        conf,
      }),
    },
    {
      key: 'SHIFT',
      role: 'assistant',
      style: 'neutral',
      content: m('SHIFT', { kind: 'direction_only', q: 0 }), // 質問は禁止（ここは0固定）
    },
  ];
}

// --------------------------------------------------
// main
// --------------------------------------------------

export function buildNormalChatSlotPlan(args: {
  userText: string;
  context?: {
    recentUserTexts?: string[];
    lastSummary?: string | null; // ✅ orchestrator互換（このファイルでは使わない）
  };
}): NormalChatSlotPlan {
  const stamp = 'normalChat@sofia-flow-v2';
  const userText = norm(args.userText);

  const recentRaw = Array.isArray(args.context?.recentUserTexts) ? args.context!.recentUserTexts! : [];
  const recent = recentRaw.map((x) => norm(x)).filter(Boolean);
  const lastUserText = recent.length > 0 ? recent[recent.length - 1] : null;

  let flow: { delta: string; confidence?: number } | null = null;
  try {
    flow = observeFlow({
      currentText: userText,
      lastUserText: lastUserText ?? undefined,
    }) as any;
  } catch {
    flow = { delta: 'FORWARD' };
  }

  let reason = 'flow';
  let slots: NormalChatSlot[] = [];

  if (!userText) {
    reason = 'empty';
    slots = buildEmpty();
  } else if (isEnd(userText)) {
    reason = 'end';
    slots = buildEnd();
  } else if (isCompose(userText)) {
    reason = 'compose';
    slots = buildCompose(userText);
  } else {
    const d = flow?.delta ? String(flow.delta) : 'FORWARD';
    reason = `flow:${d}`;
    slots = buildFlowReply(userText, flow);
  }

  return {
    kind: 'normal-chat',
    stamp,
    reason,
    slotPlanPolicy: 'FINAL',
    slots: normalizeSlots(slots),
  };
}
