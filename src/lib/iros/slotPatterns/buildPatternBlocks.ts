import { IR_DETAIL_V1 } from './irDetailV1';
import type {
  BuiltPatternBlock,
  PatternBuildInput,
  PatternBuildResult,
  PatternKey,
  PatternSpec,
} from './types';

const EMPTY_NORMAL_V1: PatternSpec = {
  key: 'NORMAL_V1',
  mode: 'normal',
  slots: [],
};

const EMPTY_TRUTH_V1: PatternSpec = {
  key: 'TRUTH_V1',
  mode: 'truth',
  slots: [],
};

const EMPTY_IR_LIGHT_V1: PatternSpec = {
  key: 'IR_LIGHT_V1',
  mode: 'ir',
  slots: [],
};

const PATTERN_SPECS: Record<PatternKey, PatternSpec> = {
  NORMAL_V1: EMPTY_NORMAL_V1,
  TRUTH_V1: EMPTY_TRUTH_V1,
  IR_LIGHT_V1: EMPTY_IR_LIGHT_V1,
  IR_DETAIL_V1,
};

function getPatternSpec(patternKey: PatternKey): PatternSpec {
  return PATTERN_SPECS[patternKey] ?? EMPTY_NORMAL_V1;
}

function flattenPatternBlocks(spec: PatternSpec): BuiltPatternBlock[] {
  const blocks: BuiltPatternBlock[] = [];

  for (const slot of spec.slots) {
    for (const block of slot.blocks) {
      blocks.push({
        slotKey: slot.key,
        blockKey: block.key,
        heading: slot.heading,
        required: block.required,
      });
    }
  }

  return blocks;
}

export function buildPatternBlocks(input: PatternBuildInput): PatternBuildResult {
  const patternKey = input.patternKey;
  const spec = getPatternSpec(patternKey);
  const blocks = flattenPatternBlocks(spec);

  return {
    patternKey,
    blocks,
  };
}
