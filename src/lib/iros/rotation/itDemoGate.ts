// file: src/lib/iros/rotation/itDemoGate.ts
// iros — IT demo gate (bridge)
// 目的：
// - history から recentUserTexts を拾って decideRepeatGate() で sameIntentStreak を作る
// - detectILayerForce() に sameIntentStreak / qTrace / requestedDepth / mode を渡す
// - 戻り値に renderMode='IT' の判定と理由をまとめて返す
//
// これにより上流は：
//   const g = runItDemoGate({ userText, history, mode, requestedDepth, qTrace });
//   if (g.renderMode==='IT') meta.renderMode='IT'
// だけでデモが動く（Q非依存）

import type { Depth, IrosMode } from '@/lib/iros/system';

import { decideRepeatGate } from './qBrakeRelease';
import { detectILayerForce } from './iLayerForce';

type HistoryLikeMessage = {
  role?: string;
  content?: unknown;
  text?: unknown;
  message?: unknown;
};

function normRole(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

function pickText(m: any): string {
  return String(m?.content ?? m?.text ?? m?.message ?? '').trim();
}

export type ItDemoGateResult = {
  // ここがデモの主役
  renderMode: 'NORMAL' | 'IT';
  itReason?: string;
  itEvidence?: Record<string, unknown>;

  // I/T 明示フォース（必要なら併用できる）
  force: boolean;
  dual: boolean;
  requestedDepth?: Depth;
  requestedMode?: IrosMode;
  reason: string;

  // repeat 側の詳細（ログに出す用）
  sameIntentStreak: number;
  repeatReason: string;
  repeatDetail: Record<string, unknown>;
};

/**
 * history から user 発話を拾う（最新が末尾の想定だが、逆でも最後だけ使うので壊れない）
 * - 直近 maxPick 件だけ拾う（軽量）
 * - 「今ターンの userText」は除外したいので、上流が history に含める前提ならOK
 */
function pickRecentUserTexts(history: unknown[], maxPick: number): string[] {
  if (!Array.isArray(history) || history.length === 0) return [];

  const out: string[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < maxPick; i--) {
    const m = history[i] as HistoryLikeMessage;
    if (!m) continue;
    if (normRole(m.role) !== 'user') continue;

    const t = pickText(m);
    if (!t) continue;

    out.push(t);
  }

  // reverseして「古→新」っぽく戻す（decideRepeatGateはどっちでもいいが、ログが読みやすい）
  return out.reverse();
}

/**
 * runItDemoGate
 * - sameIntentStreak（2回目）→ IT
 * - iLayerForce（明示ワード）→ I/T を確実化
 */
export function runItDemoGate(args: {
  userText: string;

  // 上流が持ってるはずのもの
  history?: unknown[]; // messages履歴
  qTrace?: { streakLength?: number | null } | null;

  mode?: IrosMode | null;
  requestedDepth?: Depth | null;

  // デモ調整
  repeatThreshold?: number; // default 0.82
  repeatMinLen?: number; // default 10
  maxPick?: number; // default 12

  // 強制スイッチ
  itForce?: boolean | null;
}): ItDemoGateResult {
  const history = Array.isArray(args.history) ? args.history : [];
  const recentUserTexts = pickRecentUserTexts(history, Math.max(1, args.maxPick ?? 12));

  const repeat = decideRepeatGate({
    textNow: args.userText,
    recentUserTexts,
    threshold: args.repeatThreshold ?? 0.82,
    minLen: args.repeatMinLen ?? 10,
  });

  const forced = detectILayerForce({
    userText: args.userText,
    mode: args.mode ?? null,
    requestedDepth: args.requestedDepth ?? null,

    // ★ここが今回の肝：Repeat結果をそのまま渡す
    sameIntentStreak: repeat.sameIntentStreak,
    qTrace: args.qTrace ?? null,

    // 手動IT（デモ確実）
    itForce: args.itForce ?? null,

    // しきい値は2固定でOK（必要なら expose）
    itThreshold: 2,
  });

  return {
    renderMode: forced.renderMode,
    itReason: forced.itReason,
    itEvidence: forced.itEvidence,

    force: forced.force,
    dual: forced.dual,
    requestedDepth: forced.requestedDepth,
    requestedMode: forced.requestedMode,
    reason: forced.reason,

    sameIntentStreak: repeat.sameIntentStreak,
    repeatReason: repeat.reason,
    repeatDetail: {
      ...repeat.detail,
      recentUserTextsCount: recentUserTexts.length,
    },
  };
}
