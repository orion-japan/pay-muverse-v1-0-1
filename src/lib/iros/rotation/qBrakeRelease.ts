// file: src/lib/iros/rotation/qBrakeRelease.ts
// iros — Repeat / Stagnation Gate (Q-independent) + Legacy QBrakeRelease (compat)
//
// ✅ 目的（今回のデモ）
// - 「同じ相談を2回投げる」→ sameIntentStreak >= 2 を安定生成（Q非依存）
// - iLayerForce.ts に sameIntentStreak を渡す素材を作る（純関数）
//
// ✅ 互換（既存コードを壊さない）
// - generate.ts 等が import している `decideQBrakeRelease` / `normalizeQ` を復活
// - 旧Qブレーキ解除ロジックも同ファイルに“併存”させる

/* =========================================================
 *  A) Repeat / Stagnation Gate（Q非依存）
 * ======================================================= */

export type RepeatTriggerReason =
  | 'EXACT_MATCH'
  | 'SIMILARITY_MATCH'
  | 'NO_HISTORY'
  | 'TOO_SHORT'
  | 'NO_MATCH';

export type RepeatGateDecision = {
  sameIntentStreak: number; // 1=初回 / 2=2回目 / 3=3回目...
  shouldEscalateIT: boolean; // sameIntentStreak>=2 を返す
  reason: RepeatTriggerReason;
  detail: {
    textNow: string;
    lastUserText: string | null;
    similarity: number | null;
    threshold: number;
    minLen: number;
  };
};

function normText(s: unknown): string {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[　]/g, ' ')
    .trim();
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** 文字bigram集合（軽量） */
function toBigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** Jaccard(sim) = |A∩B| / |A∪B| */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;

  const union = a.size + b.size - inter;
  return clamp01(union === 0 ? 0 : inter / union);
}

/**
 * 直近ユーザー発話の中で「同一テーマ」判定が何連続かを返す
 */
export function decideRepeatGate(args: {
  textNow: unknown;
  recentUserTexts: unknown[]; // 最新が末尾でも先頭でもOK（内部で最後を使う）
  threshold?: number; // default 0.82
  minLen?: number; // default 10
}): RepeatGateDecision {
  const textNow = normText(args.textNow);
  const threshold = Math.max(0.6, Math.min(0.95, Number(args.threshold ?? 0.82)));
  const minLen = Math.max(4, Math.round(Number(args.minLen ?? 10)));

  const raw = Array.isArray(args.recentUserTexts) ? args.recentUserTexts : [];
  const texts = raw.map(normText).filter((s) => s.length > 0);

  if (!textNow) {
    return {
      sameIntentStreak: 1,
      shouldEscalateIT: false,
      reason: 'TOO_SHORT',
      detail: {
        textNow,
        lastUserText: texts.length ? texts[texts.length - 1] : null,
        similarity: null,
        threshold,
        minLen,
      },
    };
  }

  if (texts.length === 0) {
    return {
      sameIntentStreak: 1,
      shouldEscalateIT: false,
      reason: 'NO_HISTORY',
      detail: { textNow, lastUserText: null, similarity: null, threshold, minLen },
    };
  }

  const last = texts[texts.length - 1] ?? null;
  const tooShort = textNow.length < minLen;

  if (last && textNow === last) {
    return {
      sameIntentStreak: 2,
      shouldEscalateIT: true,
      reason: 'EXACT_MATCH',
      detail: { textNow, lastUserText: last, similarity: 1, threshold, minLen },
    };
  }

  if (tooShort) {
    return {
      sameIntentStreak: 1,
      shouldEscalateIT: false,
      reason: 'TOO_SHORT',
      detail: { textNow, lastUserText: last, similarity: null, threshold, minLen },
    };
  }

  const sim = last ? jaccard(toBigrams(textNow), toBigrams(last)) : 0;

  if (last && sim >= threshold) {
    return {
      sameIntentStreak: 2,
      shouldEscalateIT: true,
      reason: 'SIMILARITY_MATCH',
      detail: { textNow, lastUserText: last, similarity: sim, threshold, minLen },
    };
  }

  return {
    sameIntentStreak: 1,
    shouldEscalateIT: false,
    reason: 'NO_MATCH',
    detail: { textNow, lastUserText: last, similarity: sim, threshold, minLen },
  };
}

/* =========================================================
 *  B) Legacy: Q-triggered "general brake release"（互換）
 * ======================================================= */

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export type BrakeReleaseReason =
  | 'Q2_STREAK_SA60'
  | 'Q2_2OF3_NORMAL'
  | 'Q3_PIVOT'
  | 'Q4_FEAR'
  | 'Q5_FIRE'
  | 'Q1_SUPPRESS'
  | 'SA_OUT_OF_RANGE'
  | 'NO_TRIGGER';

export type QBrakeDecision = {
  shouldRelease: boolean;
  forceIntentLayer: 'I' | null;
  reason: BrakeReleaseReason;
  detail: {
    qNow: QCode | null;
    sa: number | null;
    saGate_038_090: boolean;
    saGate_060_090: boolean;

    qNow_streak2: boolean;
    q2_streak2: boolean;
    q1_streak2: boolean;

    q2_2of3: boolean;
  };
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** ✅ generate.ts 互換のため export を復活 */
export function normalizeQ(v: unknown): QCode | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  if (s === 'Q1' || s === 'Q2' || s === 'Q3' || s === 'Q4' || s === 'Q5') return s;
  return null;
}

/** ✅ generate.ts 互換のため export を復活 */
export function decideQBrakeRelease(args: {
  qNow: unknown;
  sa: unknown;
  recentUserQs: unknown[]; // newest last
}): QBrakeDecision {
  const qNow = normalizeQ(args.qNow);
  const sa = isFiniteNumber(args.sa) ? args.sa : null;

  const saGate_038_090 = sa != null && sa >= 0.38 && sa <= 0.9;
  const saGate_060_090 = sa != null && sa >= 0.6 && sa <= 0.9;

  const qsRaw = Array.isArray(args.recentUserQs) ? args.recentUserQs : [];
  const qs: QCode[] = qsRaw.map(normalizeQ).filter((x): x is QCode => x != null);

  const last = qs.length >= 1 ? qs[qs.length - 1] : null;

  // ✅ 「直近が同じQ」なら “streak2相当” とみなす（generateの時点で取れる情報で確実に動く）
  const qNow_streak2 = !!(qNow && last === qNow);

  const q2_streak2 = qNow === 'Q2' && qNow_streak2;
  const q1_streak2 = qNow === 'Q1' && qNow_streak2;

  const last3 = qs.slice(Math.max(0, qs.length - 3));
  const q2Count = last3.filter((x) => x === 'Q2').length;
  const q2_2of3 = q2Count >= 2;

  if (!saGate_038_090) {
    return {
      shouldRelease: false,
      forceIntentLayer: null,
      reason: 'SA_OUT_OF_RANGE',
      detail: {
        qNow,
        sa,
        saGate_038_090,
        saGate_060_090,
        qNow_streak2,
        q2_streak2,
        q1_streak2,
        q2_2of3,
      },
    };
  }

  let shouldRelease = false;
  let reason: BrakeReleaseReason = 'NO_TRIGGER';

  if (qNow === 'Q3') {
    shouldRelease = true;
    reason = 'Q3_PIVOT';
  } else if (qNow === 'Q4') {
    shouldRelease = true;
    reason = 'Q4_FEAR';
  } else if (qNow === 'Q5') {
    shouldRelease = true;
    reason = 'Q5_FIRE';
  } else if (qNow === 'Q2') {
    if (q2_streak2 && saGate_060_090) {
      shouldRelease = true;
      reason = 'Q2_STREAK_SA60';
    } else if (q2_2of3) {
      shouldRelease = true;
      reason = 'Q2_2OF3_NORMAL';
    }
  } else if (qNow === 'Q1') {
    if (q1_streak2) {
      shouldRelease = true;
      reason = 'Q1_SUPPRESS';
    }
  }

  return {
    shouldRelease,
    forceIntentLayer: shouldRelease ? 'I' : null,
    reason,
    detail: {
      qNow,
      sa,
      saGate_038_090,
      saGate_060_090,
      qNow_streak2,
      q2_streak2,
      q1_streak2,
      q2_2of3,
    },
  };
}
