// src/lib/iros/flow/flowEngine.ts
// iros — Flow Engine v1
//
// 目的:
// - current flow の確定
// - previous flow の薄い継承
// - future flow random の生成（現在状態や流れを見ない）
// - prev -> now の差分生成
// - LLMへ渡す最小 seed の生成
//
// 方針:
// - card は使わない
// - runtime では flow180.ts の short だけを使う
// - future は常に random（予言禁止 / 現在非依存）
// - 差分は prev -> now を構造で持ち、文字は副産物として作る

import {
  FLOW_STAGE_ORDER,
  FLOW180,
  type FlowDelta,
  type FlowEnergy,
  type FlowPolarity,
  type FlowStage,
  type FlowStateEntry,
  type FlowStateId,
  buildFlowDelta,
  getFlowShort,
  getFlowState,
  makeFlowStateId,
} from './flow180';

export type Phase = 'Inner' | 'Outer';

export interface CurrentFlowSignalsInput {
  e_turn?: FlowEnergy | null;
  depthStage?: FlowStage | null;
  polarity?: FlowPolarity | null;
  confidence?: number | null;

  // 別軸メタ（seed 用）
  phase?: Phase | null;
  sa?: number | null;
  yuragi?: number | null;
  yohaku?: number | null;

  basedOn?: string | null;
}

export interface BuildFlowEngineInput {
  current: CurrentFlowSignalsInput;

  // 現在フローが組めない時の薄い継承
  previousNow?: {
    e_turn: FlowEnergy;
    depthStage: FlowStage;
    polarity: FlowPolarity;
  } | null;

  // future random 用
  rng?: () => number;
  futureStagePool?: FlowStage[];
  futurePolarityPool?: FlowPolarity[];
  futureETurnPool?: FlowEnergy[];
}

export type FlowSource = 'detected' | 'fallback_previous' | 'random';

export interface FlowPick {
  source: FlowSource;
  id: FlowStateId;
  energy: FlowEnergy;
  stage: FlowStage;
  polarity: FlowPolarity;
  short: string;
  confidence: number | null;
  basedOn: string | null;
}

export interface FlowEngineResult {
  currentFlow: FlowPick | null;
  previousFlow: FlowPick | null;
  futureFlowRandom: FlowPick;
  delta: FlowDelta | null;

  seedText: string;

  pack: {
    version: 'flow_engine_v1';
    current: {
      detected: boolean;
      fromPrev: boolean;
      missing: Array<'e_turn' | 'depthStage' | 'polarity'>;
      confidence: number | null;
    };
    future: {
      mode: 'random';
      note: string;
    };
    context: {
      phase: Phase | null;
      sa: number | null;
      yuragi: number | null;
      yohaku: number | null;
      saBiasHint: 'negative_risk' | 'neutral' | 'positive_capacity' | null;
      confidenceHint: 'low' | 'mid' | 'high' | null;
    };
  };

  debug: {
    futureStagePoolSize: number;
  };
}

const FLOW_ENERGIES: readonly FlowEnergy[] = Object.freeze(['e1', 'e2', 'e3', 'e4', 'e5'] as const);
const FLOW_POLARITIES: readonly FlowPolarity[] = Object.freeze(['pos', 'neg'] as const);

// 既定: future random は T を除外（S1..I3）
const FLOW_STAGES_FUTURE_DEFAULT: readonly FlowStage[] = Object.freeze(
  FLOW_STAGE_ORDER.filter((s) => !s.startsWith('T')) as FlowStage[],
);

function clamp01(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function pickOne<T>(arr: readonly T[], rng: () => number): T {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('pickOne: empty array');
  }
  const r = rng();
  const x = Number.isFinite(r) ? r : Math.random();
  const i = Math.max(0, Math.min(arr.length - 1, Math.floor(x * arr.length)));
  return arr[i];
}

function deriveSaBiasHint(
  sa: number | null,
): FlowEngineResult['pack']['context']['saBiasHint'] {
  if (sa == null) return null;
  if (sa < 0.35) return 'negative_risk';
  if (sa > 0.7) return 'positive_capacity';
  return 'neutral';
}

function deriveConfidenceHint(
  confidence: number | null,
  yuragi: number | null,
): 'low' | 'mid' | 'high' | null {
  const c0 = clamp01(confidence);
  if (c0 == null) return null;

  const y = clamp01(yuragi);
  let c = c0;

  // ゆらぎが高いと読みを一段弱める
  if (y != null && y >= 0.7) c = Math.max(0, c - 0.2);
  else if (y != null && y >= 0.45) c = Math.max(0, c - 0.1);

  if (c < 0.35) return 'low';
  if (c < 0.75) return 'mid';
  return 'high';
}

function buildFlowPick(args: {
  source: FlowSource;
  energy: FlowEnergy;
  stage: FlowStage;
  polarity: FlowPolarity;
  confidence: number | null;
  basedOn: string | null;
}): FlowPick {
  const id = makeFlowStateId(args.energy, args.stage, args.polarity);
  const state = getFlowState(id);

  if (!state) {
    throw new Error(`buildFlowPick: missing flow state for id=${id}`);
  }

  return {
    source: args.source,
    id,
    energy: args.energy,
    stage: args.stage,
    polarity: args.polarity,
    short: state.short,
    confidence: args.confidence,
    basedOn: args.basedOn,
  };
}

function buildSeedText(args: {
  currentFlow: FlowPick | null;
  previousFlow: FlowPick | null;
  futureFlowRandom: FlowPick;
  delta: FlowDelta | null;
  missing: Array<'e_turn' | 'depthStage' | 'polarity'>;
  context: FlowEngineResult['pack']['context'];
}): string {
  const ctxParts = [
    args.context.phase ? `phase=${args.context.phase}` : null,
    args.context.sa != null ? `sa=${args.context.sa.toFixed(2)}` : null,
    args.context.yuragi != null ? `yuragi=${args.context.yuragi.toFixed(2)}` : null,
    args.context.yohaku != null ? `yohaku=${args.context.yohaku.toFixed(2)}` : null,
    args.context.saBiasHint ? `saBias=${args.context.saBiasHint}` : null,
    args.context.confidenceHint ? `confidence=${args.context.confidenceHint}` : null,
  ].filter(Boolean);

  const lines: string[] = [];

  lines.push('FLOW180_SEED (DO NOT OUTPUT)');
  lines.push('LEGEND:');
  lines.push('- CURRENT は「いまの状態エネルギー」。');
  lines.push('- DELTA は「どこからどこへ動いたか」。');
  lines.push('- FUTURE_RANDOM は「未来予測」ではなく、ランダムな次の角度。');

  if (ctxParts.length) {
    lines.push(`META: ${ctxParts.join(' / ')}`);
  }

  lines.push('');
  lines.push('CURRENT_FLOW:');
  if (args.currentFlow) {
    lines.push(`- id=${args.currentFlow.id} / src=${args.currentFlow.source}`);
    lines.push(`- ${args.currentFlow.short}`);
  } else {
    lines.push(`- (null) missing=${args.missing.join(',') || 'none'}`);
  }

  lines.push('');
  lines.push('FLOW_DELTA:');
  if (args.delta) {
    lines.push(`- prev=${args.delta.prev ?? '(none)'} / now=${args.delta.now}`);
    lines.push(`- type=${args.delta.deltaType}`);
    lines.push(`- ${args.delta.short}`);
  } else {
    lines.push('- (null)');
  }

  lines.push('');
  lines.push('FUTURE_FLOW_RANDOM:');
  lines.push(`- id=${args.futureFlowRandom.id} / src=random`);
  lines.push(`- ${args.futureFlowRandom.short}`);

  lines.push('');
  lines.push('RESPONSE_GUIDE (DO NOT OUTPUT):');
  lines.push('- 返答は CURRENT_FLOW を優先する。');
  lines.push('- 可能なら DELTA を一度だけ反映する。');
  lines.push('- FUTURE_FLOW_RANDOM は断定・予言に使わず、「次の角度」としてのみ扱う。');
  lines.push('- 長い説明は足さない。状態エネルギーを軸に返す。');

  return lines.join('\n').trim();
}

export function buildFlowEngineResult(input: BuildFlowEngineInput): FlowEngineResult {
  const rng = typeof input?.rng === 'function' ? input.rng : Math.random;
  const current = input?.current ?? {};

  const missing: Array<'e_turn' | 'depthStage' | 'polarity'> = [];
  const e_turn = current.e_turn ?? null;
  const depthStage = current.depthStage ?? null;
  const polarity = current.polarity ?? null;

  if (!e_turn) missing.push('e_turn');
  if (!depthStage) missing.push('depthStage');
  if (!polarity) missing.push('polarity');

  const confidence = clamp01(current.confidence);
  const sa = clamp01(current.sa);
  const yuragi = clamp01(current.yuragi);
  const yohaku = clamp01(current.yohaku);

  // previousFlow（入力があれば FlowPick 化）
  let previousFlow: FlowPick | null = null;
  if (
    input?.previousNow?.e_turn &&
    input?.previousNow?.depthStage &&
    input?.previousNow?.polarity
  ) {
    previousFlow = buildFlowPick({
      source: 'fallback_previous',
      energy: input.previousNow.e_turn,
      stage: input.previousNow.depthStage,
      polarity: input.previousNow.polarity,
      confidence,
      basedOn: 'previous_state',
    });
  }

  // currentFlow（detected | fallback_previous | null）
  let currentFlow: FlowPick | null = null;
  let fromPrev = false;

  if (missing.length === 0) {
    currentFlow = buildFlowPick({
      source: 'detected',
      energy: e_turn as FlowEnergy,
      stage: depthStage as FlowStage,
      polarity: polarity as FlowPolarity,
      confidence,
      basedOn: current.basedOn ?? null,
    });
  } else if (previousFlow) {
    fromPrev = true;
    currentFlow = {
      ...previousFlow,
      source: 'fallback_previous',
      confidence,
      basedOn: current.basedOn ?? previousFlow.basedOn ?? 'previous_state_fallback',
    };
  }

  // futureFlowRandom（current を見ない）
  const stagePool =
    Array.isArray(input?.futureStagePool) && input.futureStagePool.length > 0
      ? input.futureStagePool
      : [...FLOW_STAGES_FUTURE_DEFAULT];

  const energyPool =
    Array.isArray(input?.futureETurnPool) && input.futureETurnPool.length > 0
      ? input.futureETurnPool
      : [...FLOW_ENERGIES];

  const polarityPool =
    Array.isArray(input?.futurePolarityPool) && input.futurePolarityPool.length > 0
      ? input.futurePolarityPool
      : [...FLOW_POLARITIES];

  const futureEnergy = pickOne(energyPool, rng);
  const futureStage = pickOne(stagePool, rng);
  const futurePolarity = pickOne(polarityPool, rng);

  const futureFlowRandom = buildFlowPick({
    source: 'random',
    energy: futureEnergy,
    stage: futureStage,
    polarity: futurePolarity,
    confidence,
    basedOn: 'future_pool_pick',
  });

  // delta（prev -> now）
  const delta =
    currentFlow != null
      ? buildFlowDelta(previousFlow?.id ?? null, currentFlow.id)
      : null;

  const context: FlowEngineResult['pack']['context'] = {
    phase: current.phase ?? null,
    sa,
    yuragi,
    yohaku,
    saBiasHint: deriveSaBiasHint(sa),
    confidenceHint: deriveConfidenceHint(confidence, yuragi),
  };

  const seedText = buildSeedText({
    currentFlow,
    previousFlow,
    futureFlowRandom,
    delta,
    missing,
    context,
  });

  return {
    currentFlow,
    previousFlow,
    futureFlowRandom,
    delta,
    seedText,
    pack: {
      version: 'flow_engine_v1',
      current: {
        detected: currentFlow?.source === 'detected',
        fromPrev,
        missing,
        confidence,
      },
      future: {
        mode: 'random',
        note: 'future flow is a random candidate; it is not a deterministic prediction',
      },
      context,
    },
    debug: {
      futureStagePoolSize: stagePool.length,
    },
  };
}

export function formatFlowEngineResultForLLM(result: FlowEngineResult): string {
  return String(result.seedText ?? '').trim();
}

export function getRandomFlowStateId(rng?: () => number): FlowStateId {
  const rr = typeof rng === 'function' ? rng : Math.random;
  const energy = pickOne(FLOW_ENERGIES, rr);
  const stage = pickOne(FLOW_STAGE_ORDER, rr);
  const polarity = pickOne(FLOW_POLARITIES, rr);
  return makeFlowStateId(energy, stage, polarity);
}

export function hasFlowStateId(id: string | null | undefined): id is FlowStateId {
  return !!id && id in FLOW180;
}
