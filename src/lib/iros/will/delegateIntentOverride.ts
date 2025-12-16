// src/lib/iros/will/delegateIntentOverride.ts
// delegate intent（任せる／進めて）検出時に、goal/priority と meta を同時に寄せる

import type { IrosMeta } from '../system';

type AnyGoal = any;
type AnyPriority = any;

const DELEGATE_PATTERNS: RegExp[] = [
  /任せ(ます|る)/,
  /進めて/,
  /決めて/,
  /動かして/,
  /やっておいて/,
  /選ばせないで/,
];

function isDelegateIntent(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  return DELEGATE_PATTERNS.some((r) => r.test(t));
}

export function applyDelegateIntentOverride(args: {
  goal: AnyGoal;
  priority: AnyPriority;
  text: string;
  meta?: IrosMeta | null;
}): { goal: AnyGoal; priority: AnyPriority; meta?: IrosMeta | null } {
  const { goal, priority, text, meta } = args;

  if (!isDelegateIntent(text)) {
    return { goal, priority, meta };
  }

  const nextGoal: AnyGoal = { ...(goal ?? {}) };
  const nextPriority: AnyPriority = { ...(priority ?? {}) };

  // goal を行動フェーズ寄りに固定
  nextGoal.kind = 'enableAction';
  nextGoal.targetDepth = 'C1';
  if (typeof nextGoal.reason !== 'string' || !nextGoal.reason) {
    nextGoal.reason = 'ユーザーが決定権を委譲しているため、行動に落とす（C1）';
  }

  // priority を forward 寄りに
  nextPriority.goal = { ...(nextPriority.goal ?? {}) };
  nextPriority.goal.targetDepth = 'C1';

  const weights = { ...(nextPriority.weights ?? {}) };
  const currentForward = typeof weights.forward === 'number' ? weights.forward : 0;
  const currentMirror = typeof weights.mirror === 'number' ? weights.mirror : 0.8;

  weights.forward = Math.max(currentForward, 0.9);
  weights.mirror = Math.min(currentMirror, 0.6);
  nextPriority.weights = weights;

  // ★ ここが本題：質問終わり＆単独🌀を抑制するため meta にフラグを立てる
  let nextMeta: IrosMeta | null | undefined = meta ? ({ ...(meta as any) } as IrosMeta) : meta;

  if (nextMeta && typeof nextMeta === 'object') {
    (nextMeta as any).noQuestion = true;
    (nextMeta as any).replyStyleHint = 'no-question-action-first';
  }

  return { goal: nextGoal, priority: nextPriority, meta: nextMeta };
}
