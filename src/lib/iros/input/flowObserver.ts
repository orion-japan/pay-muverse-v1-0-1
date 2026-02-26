// src/lib/iros/input/flowObserver.ts

export type FlowDelta = 'FORWARD' | 'LATERAL' | 'RETURN';

export type FlowObservation = {
  delta: FlowDelta; // 変化の向き（評価しない）
  confidence: number; // 0..1（低くてOK）
  returnStreak: number; // ✅ RETURN 連続回数（0..）
};

function norm(s: unknown) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 直前との差分だけを見る（意味は読まない）
 * - streak は「直前が RETURN だったか」を引数で受けて 1 ずつ積む
 * - 状態は持たない（呼び出し元で prevReturnStreak を渡す）
 */
export function observeFlow(args: {
  currentText: string;
  lastUserText?: string | null;

  // ✅ 呼び出し元が持っている直前streak（無ければ 0）
  prevReturnStreak?: number | null;
}): FlowObservation {
  const cur = norm(args.currentText);
  const prev = norm(args.lastUserText ?? '');

  const prevStreak = Number(args.prevReturnStreak ?? 0);
  const safePrevStreak = Number.isFinite(prevStreak) && prevStreak > 0 ? prevStreak : 0;

  if (!prev) {
    return { delta: 'FORWARD', confidence: 0.4, returnStreak: 0 };
  }

  // 単純な距離感（編集距離ではなく粗い一致率）
  const sameHead = cur.slice(0, 12) === prev.slice(0, 12);
  const overlap =
    cur.length && prev.length
      ? cur.split(' ').filter((w) => prev.includes(w)).length / Math.max(1, cur.split(' ').length)
      : 0;

  const isReturn = sameHead || overlap > 0.6;
  if (isReturn) {
    return { delta: 'RETURN', confidence: 0.7, returnStreak: safePrevStreak + 1 };
  }

  if (overlap > 0.3) {
    return { delta: 'LATERAL', confidence: 0.6, returnStreak: 0 };
  }

  return { delta: 'FORWARD', confidence: 0.6, returnStreak: 0 };
}
