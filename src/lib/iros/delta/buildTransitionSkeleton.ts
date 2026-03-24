import type { TransitionMeaning } from '@/lib/iros/delta/transitionMeaning';

export type TransitionSkeletonInput = {
  transitionMeaning: TransitionMeaning;

  focus?: string | null;
  relationContext?: string | null;
  oneLineConstraint?: string | null;
};

export type TransitionSkeletonOutput = {
  skeleton: string;
  rule: {
    maxLines: 1;
    noExtraExplanation: true;
    noList: true;
    noQuestion: true;
  };
  parts: {
    transitionMeaning: TransitionMeaning;
    focus: string | null;
    relationContext: string | null;
    oneLineConstraint: string | null;
  };
};

function norm(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length ? s : null;
}

function joinParts(parts: Array<string | null | false>): string {
  return parts.filter(Boolean).join(' / ');
}

function baseLine(kind: TransitionMeaning): string {
  switch (kind) {
    case 'forward':
      return 'いま進行中';
    case 'backward':
      return 'いま戻り中';
    case 'stagnation':
      return 'いま停滞中';
    case 'jump':
      return 'いま跳躍中';
    case 'collapse':
      return 'いま崩壊中';
    case 'stabilize':
      return 'いま安定中';
    case 'pre_hit':
      return 'いま直前';
  }
}

export function buildTransitionSkeleton(
  input: TransitionSkeletonInput
): TransitionSkeletonOutput {
  const transitionMeaning = input.transitionMeaning;
  const focus = norm(input.focus);
  const relationContext = norm(input.relationContext);
  const oneLineConstraint = norm(input.oneLineConstraint);

  const skeleton = joinParts([
    baseLine(transitionMeaning),
    focus && `焦点=${focus}`,
    relationContext && `関係=${relationContext}`,
    oneLineConstraint && `制約=${oneLineConstraint}`,
  ]);

  return {
    skeleton,
    rule: {
      maxLines: 1,
      noExtraExplanation: true,
      noList: true,
      noQuestion: true,
    },
    parts: {
      transitionMeaning,
      focus,
      relationContext,
      oneLineConstraint,
    },
  };
}
