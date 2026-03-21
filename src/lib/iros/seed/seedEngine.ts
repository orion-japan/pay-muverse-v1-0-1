// =============================================
// file: src/lib/iros/seed/seedEngine.ts
// SEED ENGINE v2.1改
// - flowEngine = 状態（点）
// - seedEngine = 文脈理解＋圧縮（線）
// - LLM = 表現（音）
// =============================================

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

  goalKind?: string | null;
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
};

function pickString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function hasArrowLike(delta: string | null): boolean {
  if (!delta) return false;
  return /→|->|⇒|=>/.test(delta);
}

function deriveFocus(ctx: FlowSeedV21['context']): string {
  if (ctx.userCore) return ctx.userCore;
  if (ctx.historyLine) return ctx.historyLine;
  if (ctx.memoryLine) return ctx.memoryLine;
  return '次の一手';
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
    focus: deriveFocus(context),
    tone: deriveTone(flow, context),
    pressure: derivePressure(flow, context),
  };

  return {
    flow,
    context,
    compression,
    goalKind: pickString(input.goalKind),
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

  lines.push('');
  lines.push('FOCUS:');
  lines.push(seed.compression.focus);

  lines.push('');
  lines.push('TONE:');
  lines.push(seed.compression.tone);

  lines.push('');
  lines.push('PRESSURE:');
  lines.push(
    seed.goalKind === 'uncover' && seed.compression.pressure === 'observe'
      ? 'uncover'
      : seed.compression.pressure
  );
  return lines.join('\n').trim();
}
