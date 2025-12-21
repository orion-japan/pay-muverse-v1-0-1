// file: src/lib/iros/language/renderReply.ts
// iros — Field Rendering (文章レンダリング層) [presentation-minimal]

import type { ResonanceVector } from './resonanceVector';
import type { ReplyPlan, ContainerId, ReplySlotKey } from './planReply';

export type RenderMode = 'casual' | 'intent' | 'transcend';

export type RenderInput = {
  facts: string;
  insight?: string | null;
  nextStep?: string | null;
  userWantsEssence?: boolean;
  highDefensiveness?: boolean;
  seed?: string;
  userText?: string | null;
};

export type RenderOptions = {
  mode?: RenderMode;
  forceExposeInsight?: boolean;
  minimalEmoji?: boolean;
  maxLines?: number;
};

// IT 密度（IT モード専用）
export type ItDensity = 'micro' | 'compact' | 'normal';

export function renderReply(
  vector: ResonanceVector,
  input: RenderInput,
  opts: RenderOptions = {},
): string {
  // ---------------------------------
  // 強制指定の回収
  // ---------------------------------
  const forcedRenderMode =
    ((opts as any)?.renderMode ??
      (opts as any)?.meta?.renderMode ??
      (opts as any)?.extra?.renderMode) as string | undefined;

  const forcedItDensityRaw =
    (opts as any)?.itDensity ??
    (opts as any)?.density ??
    (vector as any)?.itDensity ??
    (vector as any)?.meta?.extra?.itDensity ??
    (vector as any)?.extra?.itDensity ??
    null;

  const forcedItDensity: ItDensity =
    String(forcedItDensityRaw ?? '').toLowerCase() === 'micro'
      ? 'micro'
      : String(forcedItDensityRaw ?? '').toLowerCase() === 'compact'
        ? 'compact'
        : 'normal';

  const maxLines = typeof opts.maxLines === 'number' ? opts.maxLines : 10;

  const factsRaw = normalizeOne(input.facts);
  const userTextRaw = normalizeNullable(input.userText) ?? '';

  // =========================================================
  // ✅ プレゼン最重要ルール
  // 通常モードは「facts だけ」返す
  // =========================================================
  if (forcedRenderMode !== 'IT') {
    return clampLines(factsRaw.trim(), Math.min(maxLines, 6)).trim();
  }

  // =========================================================
  // ✅ IT モードのみ、構造化レンダリング
  // =========================================================
  const seed =
    (input.seed && input.seed.trim()) ||
    stableSeedFromInput(vector, input);

  const minimalEmoji = !!opts.minimalEmoji;

  const insightRaw =
    normalizeNullable(input.insight);

  const nextRaw =
    normalizeNullable(input.nextStep);

  const spinStep = ((vector as any).spinStep ?? null) as number | null;
  const spinLoop = ((vector as any).spinLoop ?? null) as string | null;
  const descentGate = ((vector as any).descentGate ?? null) as
    | 'closed'
    | 'offered'
    | 'accepted'
    | null;

  const isDescent = spinLoop === 'TCF' || descentGate !== 'closed';

  const itText = renderITStructured({
    seed,
    minimalEmoji,
    maxLines,
    itDensity: forcedItDensity,
    userText: userTextRaw,
    facts: factsRaw,
    insight: insightRaw,
    nextStep: nextRaw,
    isDescent,
    spinStep,
  });

  return itText.trim();
}

/* =========================================================
   IT structured renderer（唯一の自動文章ブロック）
========================================================= */

function renderITStructured(args: {
  seed: string;
  minimalEmoji: boolean;
  maxLines: number;
  itDensity: ItDensity;
  userText: string;
  facts: string;
  insight: string | null;
  nextStep: string | null;
  isDescent: boolean;
  spinStep: number | null;
}): string {
  const {
    minimalEmoji,
    maxLines,
    itDensity,
    userText,
    facts,
    insight,
    nextStep,
    isDescent,
    spinStep,
  } = args;

  function soften(x: string): string {
    const t = (x ?? '').toString().trim();
    if (!t) return '';
    return t.length > 40 ? t.slice(0, 40) + '…' : t;
  }

  // I：状態定義（最短）
  const I =
    insight?.trim() ||
    (userText
      ? `いまは、${soften(userText)} を一手に落とせていないだけです。`
      : facts
        ? `いまは、${soften(facts)} を一手に落としていないだけです。`
        : 'いまは状況を一度だけ確定する局面です。');

  // T：方向
  const T = '先に「短く通せる形」を1つ作る。';

  // C：一歩
  const baseNext = nextStep?.trim() || '次の1手だけ決める。';
  const C = isDescent
    ? `今は、${adjustNextForDescent(baseNext, spinStep)}`
    : `今は、${baseNext}`;

  // F：余韻
  const F = minimalEmoji ? 'もう進めます。' : 'もう進めます。🪔';

  if (itDensity === 'micro') {
    return clampLines([I, T, C, F].join('\n'), Math.min(maxLines, 8));
  }

  if (itDensity === 'compact') {
    return clampLines([I, '', T, '', C, '', F].join('\n'), Math.min(maxLines, 10));
  }

  // normal
  return clampLines(
    [I, '', T, '', C, '必要なら短い一通だけ先に置く。', '', F].join('\n'),
    Math.min(maxLines, 12),
  );
}

/* =========================================================
   Helpers
========================================================= */

function adjustNextForDescent(next: string, spinStep: number | null): string {
  const base = next.trim();
  if (!base) return base;

  if (spinStep === 2) return `${base} を毎日1回だけ`;
  if (spinStep === 1) return `${base} を形にして残す`;
  return `${base} を一度だけ整える`;
}

function normalizeOne(s: string): string {
  return (s ?? '').toString().trim();
}

function normalizeNullable(s?: string | null): string | null {
  const t = (s ?? '').toString().trim();
  return t.length ? t : null;
}

function clampLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n');
}

function stableSeedFromInput(vector: ResonanceVector, input: RenderInput): string {
  const parts = [
    input.facts ?? '',
    input.insight ?? '',
    input.nextStep ?? '',
    String((vector as any).depthLevel ?? ''),
  ].join('|');

  return String(simpleHash(parts));
}

function simpleHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}
