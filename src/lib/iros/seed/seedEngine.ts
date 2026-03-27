// =============================================
// file: src/lib/iros/seed/seedEngine.ts
// SEED ENGINE v2.3
// - flowEngine = 状態（点）
// - meaning = flow直結（1本）
// - seedEngine = writer正本（線）
// - LLM = 表現（音）
// =============================================

import {
  buildSeedCanonical,
  type Flow180Like,
  type MeaningSkeletonV2,
  type SeedCanonical,
  type WriterDirectivesLike,
} from './buildSeedCanonical';

export type FlowSeedV21 = {
  flow: {
    current: string | null;
    prev: string | null;
    delta: string | null;
    energy: string | null;
    futureRandom: string | null;
  };

  context: {
    userCore: string | null;
    historyLine: string | null;
    memoryLine: string | null;
  };

  compression: {
    focus: string;
    tone: string;
    pressure: string;
  };

  /** 🔥 追加：意味（flow直結） */
  meaning?: string | null;

  goalKind?: string | null;

  canonical?: SeedCanonical | null;
};

export type FlowSeedV21Input = {
  flow?: {
    current?: string | null;
    prev?: string | null;
    delta?: string | null;
    energy?: string | null;
    futureRandom?: string | null;
  } | null;

  userCore?: string | null;
  historyLine?: string | null;
  memoryLine?: string | null;
  goalKind?: string | null;

  meaningSkeleton?: MeaningSkeletonV2 | null;
  flow180?: Flow180Like | null;
  writerDirectives?: WriterDirectivesLike | null;

  focus?: string | null;
  tone?: string | null;
  pressure?: string | null;

  askBackAllowed?: boolean | null;
  questionsMax?: number | null;

  depthStage?: string | null;
  phase?: string | null;
  qCode?: string | null;
  eTurn?: string | null;
};

function pickString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (s === '(null)' || s === 'null' || s === 'undefined') return null;
  return s;
}

function hasArrowLike(delta: string | null): boolean {
  if (!delta) return false;
  return /→|->|⇒|=>/.test(delta);
}

function deriveFocus(ctx: FlowSeedV21['context']): string {
  const base =
    pickString(ctx.userCore) ||
    pickString(ctx.historyLine) ||
    pickString(ctx.memoryLine) ||
    '';

  if (!base) return '次の一手';

  if (base.includes('人間関係')) {
    return '誰かとのやり取りの違和感が残っている';
  }

  if (base.includes('仕事')) {
    return '進め方ではなく、引っかかりが残っている部分がある';
  }

  if (base.length > 40) {
    return base.slice(0, 40);
  }

  return base;
}

function deriveTone(
  flow: FlowSeedV21['flow'],
  ctx: FlowSeedV21['context'],
): string {
  const energy = pickString(flow.energy)?.toLowerCase() ?? '';
  const focus = pickString(ctx.userCore)?.toLowerCase() ?? '';

  if (
    energy.includes('weak') ||
    energy.includes('low') ||
    energy.includes('quiet') ||
    energy.includes('静') ||
    energy.includes('弱')
  ) {
    return 'quiet';
  }

  if (
    focus.includes('整理') ||
    focus.includes('明確') ||
    energy.includes('clear')
  ) {
    return 'clear';
  }

  return 'clear';
}

function derivePressure(
  flow: FlowSeedV21['flow'],
  ctx: FlowSeedV21['context'],
): string {
  const focus = pickString(ctx.userCore) ?? '';
  const delta = pickString(flow.delta);

  if (!delta) return 'observe';

  if (
    focus.includes('迷い') ||
    focus.includes('分からない') ||
    focus.includes('整理')
  ) {
    return 'reflect';
  }

  if (hasArrowLike(delta)) {
    return 'propose';
  }

  return 'reflect';
}

export function buildFlowSeedV1(input: FlowSeedV21Input): FlowSeedV21 {
  const flow: FlowSeedV21['flow'] = {
    current: pickString(input.flow?.current),
    prev: pickString(input.flow?.prev),
    delta: pickString(input.flow?.delta),
    energy: pickString(input.flow?.energy),
    futureRandom: pickString(input.flow?.futureRandom),
  };

  const context: FlowSeedV21['context'] = {
    userCore: pickString(input.userCore),
    historyLine: pickString(input.historyLine),
    memoryLine: pickString(input.memoryLine),
  };

  const compression: FlowSeedV21['compression'] = {
    focus: pickString(input.focus) ?? deriveFocus(context),
    tone: pickString(input.tone) ?? deriveTone(flow, context),
    pressure: pickString(input.pressure) ?? derivePressure(flow, context),
  };

  // 🔥 ここが核心（意味を1本にする）
  const meaning =
    input.meaningSkeleton?.transitionMeaning ??
    input.meaningSkeleton?.structuralMeaning ??
    null;

  const canonical = buildSeedCanonical({
    meaningSkeleton: input.meaningSkeleton ?? null,
    flow180: input.flow180 ?? null,

    focus: compression.focus,
    tone: compression.tone,
    pressure:
      pickString(input.goalKind) === 'uncover' && compression.pressure === 'observe'
        ? 'uncover'
        : compression.pressure,

    userCore: context.userCore,
    historyLine: context.historyLine,

    writerDirectives: input.writerDirectives ?? null,

    askBackAllowed: input.askBackAllowed ?? null,
    questionsMax:
      typeof input.questionsMax === 'number' ? input.questionsMax : null,

    goalKind: pickString(input.goalKind),
    depthStage: pickString(input.depthStage),
    phase: pickString(input.phase),
    qCode: pickString(input.qCode),
    eTurn: pickString(input.eTurn) ?? flow.energy,
  });

  return {
    flow,
    context,
    compression,
    meaning, // 🔥 追加
    goalKind: pickString(input.goalKind),
    canonical,
  };
}

export function formatFlowSeedV1(seed: FlowSeedV21): string {
  const lines: string[] = [];

  lines.push('FLOW:');
  lines.push(`current=${seed.flow.current ?? '(null)'}`);
  lines.push(`prev=${seed.flow.prev ?? '(null)'}`);
  lines.push(`delta=${seed.flow.delta ?? '(null)'}`);
  lines.push(`energy=${seed.flow.energy ?? '(null)'}`);
  lines.push(`futureRandom=${seed.flow.futureRandom ?? '(null)'}`);

  lines.push('');
  lines.push('CONTEXT:');
  lines.push(`userCore=${seed.context.userCore ?? '(null)'}`);
  lines.push(`historyLine=${seed.context.historyLine ?? '(null)'}`);
  lines.push(`memoryLine=${seed.context.memoryLine ?? '(null)'}`);

  // 🔥 MEANING（最重要）
  if (seed.meaning) {
    lines.push('');
    lines.push('MEANING:');
    lines.push(seed.meaning);
  }

  lines.push('');
  lines.push('FOCUS:');
  lines.push(seed.compression.focus);

  lines.push('');
  lines.push('TONE:');
  lines.push(seed.compression.tone);

  lines.push('');
  lines.push('');
  lines.push('PRESSURE:');

  const goalKindNorm =
    typeof seed.goalKind === 'string' && seed.goalKind.trim()
      ? seed.goalKind.trim().toLowerCase()
      : null;

  const pressure =
    goalKindNorm === 'clarify'
      ? 'clarify'
      : goalKindNorm === 'decide'
        ? 'push'
        : goalKindNorm === 'commit'
          ? 'force'
          : goalKindNorm === 'resonate'
            ? 'resonate'
            : goalKindNorm === 'stabilize'
              ? 'hold'
              : goalKindNorm === 'uncover' &&
                  seed.compression.pressure === 'observe'
                ? 'uncover'
                : seed.compression.pressure;

  lines.push(pressure);

  if (seed.canonical?.text) {
    lines.push('');
    lines.push(seed.canonical.text);
  }

  return lines.join('\n').trim();
}
