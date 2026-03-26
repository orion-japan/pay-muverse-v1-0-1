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

function collapseSpaces(v: string): string {
  return v.replace(/\s+/g, ' ').trim();
}

function stripInternalNoise(v: string): string {
  return collapseSpaces(
    v
      .replace(/SEED\s*\(DO NOT OUTPUT\):/gi, ' ')
      .replace(/INTERNAL PACK\s*\(DO NOT OUTPUT\):/gi, ' ')
      .replace(/MEANING_SKELETON\s*\(DO NOT OUTPUT\):/gi, ' ')
      .replace(/WRITER_DIRECTIVES\s*\(DO NOT OUTPUT\):/gi, ' ')
      .replace(/FLOW180\s*\(DO NOT OUTPUT\):/gi, ' ')
      .replace(/FLOW_V2\s*\(DO NOT OUTPUT\):/gi, ' ')
      .replace(/DELTA_HINT\s*\(DO NOT OUTPUT\):/gi, ' ')
      .replace(/DO NOT OUTPUT/gi, ' ')
      .replace(/@OBS\b[\s\S]*$/gi, ' ')
      .replace(/@SHIFT\b[\s\S]*$/gi, ' ')
      .replace(/@NEXT_HINT\b[\s\S]*$/gi, ' ')
      .replace(/@SAFE\b[\s\S]*$/gi, ' ')
  );
}

function sanitizeFocus(v: string | null): string | null {
  if (!v) return null;
  const s = stripInternalNoise(v)
    .replace(/(?:^|\/)\s*補助=[^/]+/g, ' ')
    .replace(/(?:^|\/)\s*位置=[^/]+/g, ' ')
    .replace(/(?:^|\/)\s*位相=[^/]+/g, ' ')
    .replace(/(?:^|\/)\s*関係=[^/]+/g, ' ')
    .replace(/(?:^|\/)\s*制約=[^/]+/g, ' ')
    .replace(/(?:^|\/)\s*焦点=/g, ' ')
    .replace(/^[\s/]+|[\s/]+$/g, ' ');

  const out = collapseSpaces(s);
  return out ? out.slice(0, 48) : null;
}

function sanitizeRelation(v: string | null): string | null {
  if (!v) return null;
  const s = stripInternalNoise(v)
    .replace(/[()]/g, ' ')
    .replace(/→/g, ' ')
    .replace(/いったん戻って整理することで、次に進む基準ができる/g, '戻して整える')
    .replace(/いまの動きが、そのまま次の展開を開きやすい/g, '進める流れ')
    .replace(/この先は/g, ' ')
    .replace(/いまの流れは/g, ' ')
    .replace(/[「」]/g, ' ');

  const out = collapseSpaces(s);
  return out ? out.slice(0, 40) : null;
}

function sanitizeConstraint(v: string | null): string | null {
  if (!v) return null;
  const s = stripInternalNoise(v);
  const out = collapseSpaces(s);
  return out ? out.slice(0, 24) : null;
}

function direction(kind: TransitionMeaning): string {
  switch (kind) {
    case 'forward':
      return 'いまは進める側に寄せる';
    case 'backward':
      return 'いまは戻して整える側に寄せる';
    case 'stagnation':
      return 'いまは停滞点を一つに絞る';
    case 'jump':
      return 'いまは一段上の視点で決める';
    case 'collapse':
      return 'いまは崩れた一点を先に支える';
    case 'stabilize':
      return 'いまは動かず整える側に寄せる';
    case 'pre_hit':
      return 'いまは決断直前の一点を掴む';
  }
}

function joinParts(parts: Array<string | null | false>): string {
  return parts.filter(Boolean).join(' / ');
}

export function buildTransitionSkeleton(
  input: TransitionSkeletonInput
): TransitionSkeletonOutput {
  const transitionMeaning = input.transitionMeaning;
  const focus = sanitizeFocus(norm(input.focus));
  const relationContext = sanitizeRelation(norm(input.relationContext));
  const oneLineConstraint = sanitizeConstraint(norm(input.oneLineConstraint));

  const skeleton = joinParts([
    direction(transitionMeaning),
    focus ? `焦点=${focus}` : null,
    relationContext ? `流れ=${relationContext}` : null,
    oneLineConstraint ? `制約=${oneLineConstraint}` : null,
  ]).slice(0, 140);

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
