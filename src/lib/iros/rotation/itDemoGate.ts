// file: src/lib/iros/rotation/itDemoGate.ts
// iros — IT demo gate (bridge)

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
  renderMode: 'NORMAL' | 'IT';
  itReason?: string;
  itEvidence?: Record<string, unknown>;

  force: boolean;
  dual: boolean;
  requestedDepth?: Depth;
  requestedMode?: IrosMode;
  reason: string;

  sameIntentStreak: number;
  repeatReason: string;
  repeatDetail: Record<string, unknown>;
};

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
  return out.reverse();
}

export function runItDemoGate(args: {
  userText: string;

  history?: unknown[];

  // ★★ streakQ を見るので型を拡張（qTraceUpdated も拾う）
  qTrace?: { streakQ?: string | null; streakLength?: number | null } | null;
  qTraceUpdated?: { streakQ?: string | null; streakLength?: number | null } | null;

  mode?: IrosMode | null;
  requestedDepth?: Depth | null;

  repeatThreshold?: number;
  repeatMinLen?: number;
  maxPick?: number;

  // ★★ UI choiceId を直接受ける（it_ 判定をここでやる）
  choiceId?: string | null;

  // 強制スイッチ（保険）
  itForce?: boolean | null;
}): ItDemoGateResult {
  const history = Array.isArray(args.history) ? args.history : [];
  const recentUserTexts = pickRecentUserTexts(
    history,
    Math.max(1, args.maxPick ?? 12),
  );

  const repeat = decideRepeatGate({
    textNow: args.userText,
    recentUserTexts,
    threshold: args.repeatThreshold ?? 0.82,
    minLen: args.repeatMinLen ?? 10,
  });

  // =========================================================
  // ★★ IT Trigger (single source of truth)
  // 1) UI: choiceId startsWith it_
  // 2) same text twice: EXACT_MATCH only
  // 3) Q2 streak2: streakQ==='Q2' && streakLength>=2
  // =========================================================

  const choiceId = args.choiceId ?? null;

  const uiIT = !!(choiceId && String(choiceId).startsWith('it_'));

  // ★★ 要件は「完全一致」なので EXACT_MATCH のみ採用
  const sameTextTwice =
    repeat.reason === 'EXACT_MATCH' && repeat.sameIntentStreak >= 2;

  // ★★ qTrace が来ない経路があるので qTraceUpdated も拾う
  const qTraceEffective = args.qTrace ?? args.qTraceUpdated ?? null;

  const streakQ = qTraceEffective?.streakQ ?? null;
  const streakLength = qTraceEffective?.streakLength ?? null;
  const q2Streak2 = streakQ === 'Q2' && (streakLength ?? 0) >= 2;

  const manual = !!(args.itForce ?? false);

  const forceIT = manual || uiIT || sameTextTwice || q2Streak2;

  const itReasons = [
    manual ? 'MANUAL_FORCE' : null,
    uiIT ? 'UI_IT_CHOICE' : null,
    sameTextTwice ? 'SAME_TEXT_TWICE' : null,
    q2Streak2 ? 'Q2_STREAK2' : null,
  ].filter(Boolean) as string[];

  // ★★ 観客に「system切替じゃない」を説明できる証拠ログ
  console.log('[IROS/IT][itDemoGate]', {
    forceIT,
    itReasons,
    choiceId,
    sameTextTwice,
    q2Streak2,
    streakQ,
    streakLength,
    repeatReason: repeat.reason,
    sameIntentStreak: repeat.sameIntentStreak,

    // 念のため、どっちを採用したかも残す
    hasQTrace: !!args.qTrace,
    hasQTraceUpdated: !!args.qTraceUpdated,
  });

  // =========================================================
  // detectILayerForce は “I/T明示ワード” の補助として残す
  // ★★ ただし ITが決まったら itForce として渡す（配線一箇所化）
  // =========================================================

  const forced = detectILayerForce({
    userText: args.userText,
    mode: args.mode ?? null,
    requestedDepth: args.requestedDepth ?? null,

    sameIntentStreak: repeat.sameIntentStreak,
    qTrace: qTraceEffective,

    // ★★ IT確定なら常に true（ここで一箇所に収束）
    itForce: forceIT ? true : null,

    itThreshold: 2,
  });

  // ★★ renderMode はこのゲートが最終決定（唯一根拠）
  const finalRenderMode: 'NORMAL' | 'IT' = forceIT ? 'IT' : forced.renderMode;

  return {
    renderMode: finalRenderMode,
    itReason: forceIT ? itReasons.join('|') : forced.itReason,
    itEvidence: forceIT
      ? {
          choiceId,
          itReasons,
          sameTextTwice,
          q2Streak2,
          streakQ,
          streakLength,
          repeat: {
            reason: repeat.reason,
            sameIntentStreak: repeat.sameIntentStreak,
            detail: repeat.detail,
          },
        }
      : forced.itEvidence,

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
