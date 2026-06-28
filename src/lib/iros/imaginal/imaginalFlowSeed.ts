import { buildFlowEngineResult } from '@/lib/iros/flow/flowEngine';
import {
  buildHumanStateTransferSeed,
  type HumanStateTransferSeed,
  type SaPolarity,
  type UtteranceAlignment,
} from '@/lib/iros/delta/humanStateTransfer';

export type ImaginalImageSeed = {
  image_observation?: string;
  visible_events?: string[];
  visible_words?: string[];
  visible_actions?: string[];
  tension_points?: string[];
  user_reaction_hook?: string;
};

export type ImaginalFlowInputSeed = {
  e_turn?: 'e1' | 'e2' | 'e3' | 'e4' | 'e5';
  depthStage?: string;
  polarity?: 'pos' | 'neg';
  confidence?: number;
  phase?: 'Inner' | 'Outer';
  sa?: number;
  saPolarity?: SaPolarity;
  yuragi?: number;
  yohaku?: number;
  utteranceAlignment?: UtteranceAlignment;
  basedOn?: string;
};

export type ImaginalFlowBuiltSeed = {
  version: 'imaginal_flow_seed_v1';
  scope: 'current_imaginal';
  flowPriority: true;
  note: string;
  currentFlow: string | null;
  secondFlow: string | null;
  currentShort: string | null;
  secondShort: string | null;
  currentBasedOn: string | null;
  secondBasedOn: string | null;
  transferSeed: HumanStateTransferSeed | null;
  seedText: string | null;
};

export type ImaginalFlowSeedLike = {
  diagnosis_scope?: 'current_imaginal';
  flow_priority?: true;
  image_seed?: ImaginalImageSeed;
  current_flow_input_seed?: ImaginalFlowInputSeed;
  second_flow_input_seed?: ImaginalFlowInputSeed;
  imaginal_flow_seed?: ImaginalFlowBuiltSeed;
};

const FLOW_ENERGIES = ['e1', 'e2', 'e3', 'e4', 'e5'] as const;
const FLOW_POLARITIES = ['pos', 'neg'] as const;
const FLOW_STAGES = [
  'S1', 'S2', 'S3',
  'F1', 'F2', 'F3',
  'R1', 'R2', 'R3',
  'C1', 'C2', 'C3',
  'I1', 'I2', 'I3',
  'T1', 'T2', 'T3',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clean(value: unknown): string | undefined {
  const s = String(value ?? '').trim();
  return s || undefined;
}

function cleanArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 8);
  return items.length ? items : undefined;
}

function clamp01(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeEnergy(value: unknown): ImaginalFlowInputSeed['e_turn'] | undefined {
  const v = clean(value);
  return FLOW_ENERGIES.includes(v as any) ? (v as ImaginalFlowInputSeed['e_turn']) : undefined;
}

function normalizePolarity(value: unknown): ImaginalFlowInputSeed['polarity'] | undefined {
  const v = clean(value);
  return FLOW_POLARITIES.includes(v as any) ? (v as ImaginalFlowInputSeed['polarity']) : undefined;
}

function normalizeDepthStage(value: unknown): string | undefined {
  const v = clean(value)?.toUpperCase();
  return FLOW_STAGES.includes(v as any) ? v : undefined;
}

function normalizePhase(value: unknown): ImaginalFlowInputSeed['phase'] | undefined {
  const v = clean(value);
  if (v === 'Inner' || v === 'Outer') return v;
  if (v?.toLowerCase() === 'inner') return 'Inner';
  if (v?.toLowerCase() === 'outer') return 'Outer';
  return undefined;
}

function normalizeSaPolarity(value: unknown): SaPolarity | undefined {
  const v = clean(value);
  if (v === 'pos' || v === 'neg' || v === 'neutral') return v;
  return undefined;
}

function normalizeUtteranceAlignment(value: unknown): UtteranceAlignment | undefined {
  const v = clean(value);
  if (
    v === 'aligned' ||
    v === 'partially_aligned' ||
    v === 'misaligned' ||
    v === 'overstated' ||
    v === 'understated'
  ) {
    return v;
  }
  return undefined;
}

export function normalizeImaginalImageSeed(value: unknown): ImaginalImageSeed | undefined {
  if (!isRecord(value)) return undefined;
  const seed: ImaginalImageSeed = {
    image_observation: clean(value.image_observation ?? value.imageObservation),
    visible_events: cleanArray(value.visible_events ?? value.visibleEvents),
    visible_words: cleanArray(value.visible_words ?? value.visibleWords),
    visible_actions: cleanArray(value.visible_actions ?? value.visibleActions),
    tension_points: cleanArray(value.tension_points ?? value.tensionPoints),
    user_reaction_hook: clean(value.user_reaction_hook ?? value.userReactionHook),
  };
  return Object.values(seed).some(Boolean) ? seed : undefined;
}

export function normalizeImaginalFlowInputSeed(value: unknown): ImaginalFlowInputSeed | undefined {
  if (!isRecord(value)) return undefined;

  const polarity = normalizePolarity(value.polarity);
  const seed: ImaginalFlowInputSeed = {
    e_turn: normalizeEnergy(value.e_turn ?? value.eTurn ?? value.energy),
    depthStage: normalizeDepthStage(value.depthStage ?? value.depth_stage ?? value.stage),
    polarity,
    confidence: clamp01(value.confidence),
    phase: normalizePhase(value.phase),
    sa: clamp01(value.sa),
    saPolarity: normalizeSaPolarity(value.saPolarity ?? value.sa_polarity) ?? polarity,
    yuragi: clamp01(value.yuragi),
    yohaku: clamp01(value.yohaku),
    utteranceAlignment: normalizeUtteranceAlignment(value.utteranceAlignment ?? value.utterance_alignment),
    basedOn: clean(value.basedOn ?? value.based_on),
  };

  if (!seed.e_turn || !seed.depthStage || !seed.polarity) return undefined;
  return seed;
}

export function buildImaginalFlowSeed(args: {
  imageSeed?: ImaginalImageSeed;
  currentInput?: ImaginalFlowInputSeed;
  secondInput?: ImaginalFlowInputSeed;
}): ImaginalFlowBuiltSeed | null {
  const currentInput = args.currentInput;
  const secondInput = args.secondInput;
  if (!currentInput || !secondInput) return null;

  try {
    const current = buildFlowEngineResult({
      current: {
        e_turn: currentInput.e_turn,
        depthStage: currentInput.depthStage as any,
        polarity: currentInput.polarity,
        confidence: currentInput.confidence ?? null,
        phase: currentInput.phase ?? null,
        sa: currentInput.sa ?? null,
        yuragi: currentInput.yuragi ?? null,
        yohaku: currentInput.yohaku ?? null,
        basedOn: currentInput.basedOn ?? args.imageSeed?.user_reaction_hook ?? 'imaginal_image_current_state',
      },
      futureStagePool: ['I1', 'I2', 'I3'] as any,
      futurePolarityPool: ['pos'] as any,
    });

    const second = buildFlowEngineResult({
      current: {
        e_turn: secondInput.e_turn,
        depthStage: secondInput.depthStage as any,
        polarity: secondInput.polarity,
        confidence: secondInput.confidence ?? currentInput.confidence ?? null,
        phase: secondInput.phase ?? currentInput.phase ?? null,
        basedOn: secondInput.basedOn ?? 'imaginal_image_if_continued_state',
      },
      futureStagePool: ['I1', 'I2', 'I3'] as any,
      futurePolarityPool: ['pos'] as any,
    });

    const currentFlow = current.currentFlow?.id ?? null;
    const secondFlow = second.currentFlow?.id ?? null;

    const transferSeed = buildHumanStateTransferSeed({
      currentFlow,
      secondFlow,
      sa: currentInput.sa ?? null,
      saPolarity: currentInput.saPolarity ?? currentInput.polarity ?? null,
      yuragi: currentInput.yuragi ?? null,
      yohaku: currentInput.yohaku ?? null,
      utteranceAlignment: currentInput.utteranceAlignment ?? null,
    });

    const seedText = [
      'IMAGINAL_FLOW_SEED (DO NOT OUTPUT):',
      'scope=current_imaginal',
      'image_is_auxiliary=true',
      'flow_priority=true',
      'rule=画像の表面説明ではなく、未来形象が作る内的状態と、その状態を続けた場合の移管を正本にする。',
      currentFlow ? `CURRENT_FLOW=${currentFlow}` : null,
      secondFlow ? `SECOND_FLOW=${secondFlow}` : null,
      transferSeed.seedText,
    ].filter((v): v is string => Boolean(v)).join('\n').trim();

    return {
      version: 'imaginal_flow_seed_v1',
      scope: 'current_imaginal',
      flowPriority: true,
      note: '画像は補助。正本は、この画像を出した人の中で立ち上がっている未来形象が作る現在状態と、その状態を続けた場合に起こりやすい次状態。',
      currentFlow,
      secondFlow,
      currentShort: current.currentFlow?.short ?? null,
      secondShort: second.currentFlow?.short ?? null,
      currentBasedOn: current.currentFlow?.basedOn ?? null,
      secondBasedOn: second.currentFlow?.basedOn ?? null,
      transferSeed,
      seedText,
    };
  } catch (error) {
    console.warn('[imaginal-flow-seed] build skipped:', error);
    return null;
  }
}

export function applyImaginalFlowSeed<T extends ImaginalFlowSeedLike>(seed: T): T {
  const imageSeed = normalizeImaginalImageSeed((seed as any).image_seed ?? (seed as any).imageSeed);
  const currentInput = normalizeImaginalFlowInputSeed(
    (seed as any).current_flow_input_seed ?? (seed as any).currentFlowInputSeed,
  );
  const secondInput = normalizeImaginalFlowInputSeed(
    (seed as any).second_flow_input_seed ?? (seed as any).secondFlowInputSeed,
  );

  const imaginalFlowSeed = buildImaginalFlowSeed({ imageSeed, currentInput, secondInput });

  return {
    ...seed,
    diagnosis_scope: 'current_imaginal',
    flow_priority: true,
    image_seed: imageSeed ?? seed.image_seed,
    current_flow_input_seed: currentInput ?? seed.current_flow_input_seed,
    second_flow_input_seed: secondInput ?? seed.second_flow_input_seed,
    imaginal_flow_seed: imaginalFlowSeed ?? seed.imaginal_flow_seed,
  };
}
