// src/lib/iros/input/flowObserver.ts

export type FlowDelta = 'FORWARD' | 'LATERAL' | 'RETURN';

export type FlowObservation = {
  delta: FlowDelta;        // 変化の向き（評価しない）
  confidence: number;      // 0..1（低くてOK）
};

function norm(s: unknown) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// 直前との差分だけを見る（意味は読まない）
export function observeFlow(args: {
  currentText: string;
  lastUserText?: string | null;
}): FlowObservation {
  const cur = norm(args.currentText);
  const prev = norm(args.lastUserText ?? '');

  if (!prev) {
    return { delta: 'FORWARD', confidence: 0.4 };
  }

  // 単純な距離感（編集距離ではなく粗い一致率）
  const sameHead = cur.slice(0, 12) === prev.slice(0, 12);
  const overlap =
    cur.length && prev.length
      ? (cur.split(' ').filter(w => prev.includes(w)).length /
         Math.max(1, cur.split(' ').length))
      : 0;

  if (sameHead || overlap > 0.6) {
    return { delta: 'RETURN', confidence: 0.7 };
  }

  if (overlap > 0.3) {
    return { delta: 'LATERAL', confidence: 0.6 };
  }

  return { delta: 'FORWARD', confidence: 0.6 };
}
