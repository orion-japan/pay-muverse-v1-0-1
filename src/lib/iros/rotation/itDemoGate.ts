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

  // 強制スイッチ（保険） ← ★ 今回は「ボタン以外IT禁止」なので使わない
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
  // ✅ ボタン(choiceId it_*) のみで IT に入れる
  // =========================================================

  const choiceId = args.choiceId ?? null;
  const uiIT = !!(choiceId && String(choiceId).startsWith('it_'));

  // 参考情報として残す（IT判定には使わない）
  const sameTextTwice =
    repeat.reason === 'EXACT_MATCH' && repeat.sameIntentStreak >= 2;

  const qTraceEffective = args.qTrace ?? args.qTraceUpdated ?? null;
  const streakQ = qTraceEffective?.streakQ ?? null;
  const streakLength = qTraceEffective?.streakLength ?? null;
  const q2Streak2 = streakQ === 'Q2' && (streakLength ?? 0) >= 2;

  // ★★ ここが最重要：IT強制はボタンのみ
  const forceIT = uiIT;

  const itReasons = [uiIT ? 'UI_IT_CHOICE' : null].filter(Boolean) as string[];

  console.log('[IROS/IT][itDemoGate]', {
    forceIT,
    itReasons,
    choiceId,

    // ↓ これらは「観測ログ」だけ（IT判定には不使用）
    sameTextTwice,
    q2Streak2,
    streakQ,
    streakLength,
    repeatReason: repeat.reason,
    sameIntentStreak: repeat.sameIntentStreak,

    hasQTrace: !!args.qTrace,
    hasQTraceUpdated: !!args.qTraceUpdated,
  });

  // =========================================================
  // detectILayerForce は “深度/モード要求検出” だけに使う
  // ✅ ITへ寄せる材料(itForce)は一切渡さない
  // =========================================================

  const forced = detectILayerForce({
    userText: args.userText,
    mode: args.mode ?? null,
    requestedDepth: args.requestedDepth ?? null,

    sameIntentStreak: repeat.sameIntentStreak,
    qTrace: qTraceEffective,

    // ✅ ここ重要：ボタン以外でITに寄せない
    itForce: null,

    itThreshold: 2,
  });

  // ★★ renderMode は「ボタン」だけで決める（forced.renderMode は無視）
  const finalRenderMode: 'NORMAL' | 'IT' = forceIT ? 'IT' : 'NORMAL';

  return {
    renderMode: finalRenderMode,
    itReason: forceIT ? itReasons.join('|') : undefined,
    itEvidence: forceIT
      ? {
          choiceId,
          itReasons,
        }
      : undefined,

    // 深度/モード要求は forced を使う（IT化はさせない）
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
