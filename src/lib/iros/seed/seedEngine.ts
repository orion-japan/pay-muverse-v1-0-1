export type MirrorFlowSeedSourceOfTruth = {
  mirror: 'e_turn';
  position: 'observedStage';
  continuity: 'depthStage';
  motion: 'willRotation';
};

export type MirrorFlowSeedWriterDirectives = {
  tone: string | null;
  maxLines: number | null;
  slotPolicy: string | null;
  rotationMention: string | null;
};

export type MirrorFlowSeedInput = {
  observedStage: string | null;
  primaryStage?: string | null;
  secondaryStage?: string | null;

  depthStage: string | null;
  depthHistoryLite?: string[] | null;

  e_turn: string | null;
  polarity: string | null;
  basedOn?: string | null;

  willRotation?:
    | {
        axis?: string | null;
        kind?: string | null;
        reason?: string | null;
        suggestedStage?: string | null;
      }
    | null;

  tLayerHint?: string | null;
  itOk?: boolean | null;

  qCode?: string | null;
  flowDelta?: string | null;

  writerDirectives?:
    | Partial<MirrorFlowSeedWriterDirectives>
    | null;
};

export type MirrorFlowSeed = {
  sourceOfTruth: MirrorFlowSeedSourceOfTruth;

  mirror: {
    e_turn: string | null;
    polarity: string | null;
    basedOn: string | null;
  };

  position: {
    observedStage: string | null;
    primaryStage: string | null;
    secondaryStage: string | null;
  };

  continuity: {
    depthStage: string | null;
    depthHistoryLite: string[];
  };

  motion: {
    axis: string | null;
    kind: string | null;
    reason: string | null;
    suggestedStage: string | null;
  };

  openness: {
    tLayerHint: string | null;
    itOk: boolean | null;
  };

  meta: {
    qCode: string | null;
    flowDelta: string | null;
  };

  writerDirectives: MirrorFlowSeedWriterDirectives;
};

export type FormatMirrorFlowSeedResult = {
  mirrorFlowSeedText: string;
  writerDirectives: MirrorFlowSeedWriterDirectives;
  sourceOfTruth: MirrorFlowSeedSourceOfTruth;
};

function pickString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function pickBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function normalizeDepthHistoryLite(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((v) => pickString(v))
    .filter((v): v is string => !!v)
    .slice(-5);
}

function normalizePolarity(input: string | null): string | null {
  const s = pickString(input);
  if (!s) return null;
  const n = s.toLowerCase();
  if (n === 'yin' || n === 'negative' || n === 'neg') return 'yin';
  if (n === 'yang' || n === 'positive' || n === 'pos') return 'yang';
  return s;
}

function normalizeWriterDirectives(
  input: Partial<MirrorFlowSeedWriterDirectives> | null | undefined,
): MirrorFlowSeedWriterDirectives {
  const maxLinesRaw = input?.maxLines;
  const maxLines =
    typeof maxLinesRaw === 'number' && Number.isFinite(maxLinesRaw)
      ? Math.max(1, Math.floor(maxLinesRaw))
      : 6;

  return {
    tone: pickString(input?.tone) ?? 'reflective',
    maxLines,
    slotPolicy: pickString(input?.slotPolicy) ?? 'OBS_FIRST',
    rotationMention: pickString(input?.rotationMention) ?? '1sentence',
  };
}

export function buildMirrorFlowSeed(input: MirrorFlowSeedInput): MirrorFlowSeed {
  const seed: MirrorFlowSeed = {
    sourceOfTruth: {
      mirror: 'e_turn',
      position: 'observedStage',
      continuity: 'depthStage',
      motion: 'willRotation',
    },

    mirror: {
      e_turn: pickString(input.e_turn),
      polarity: normalizePolarity(pickString(input.polarity)),
      basedOn: pickString(input.basedOn),
    },

    position: {
      observedStage: pickString(input.observedStage),
      primaryStage: pickString(input.primaryStage),
      secondaryStage: pickString(input.secondaryStage),
    },

    continuity: {
      depthStage: pickString(input.depthStage),
      depthHistoryLite: normalizeDepthHistoryLite(input.depthHistoryLite),
    },

    motion: {
      axis: pickString(input.willRotation?.axis),
      kind: pickString(input.willRotation?.kind),
      reason: pickString(input.willRotation?.reason),
      suggestedStage: pickString(input.willRotation?.suggestedStage),
    },

    openness: {
      tLayerHint: pickString(input.tLayerHint),
      itOk: pickBool(input.itOk),
    },

    meta: {
      qCode: pickString(input.qCode),
      flowDelta: pickString(input.flowDelta),
    },

    writerDirectives: normalizeWriterDirectives(input.writerDirectives),
  };

  return seed;
}

export function formatMirrorFlowSeed(seed: MirrorFlowSeed): FormatMirrorFlowSeedResult {
  const lines: string[] = [];

  lines.push('MIRROR_FLOW_SEED_V1');
  lines.push('SOURCE_OF_TRUTH');
  lines.push(`mirror=${seed.sourceOfTruth.mirror}`);
  lines.push(`position=${seed.sourceOfTruth.position}`);

  lines.push('');
  lines.push('MIRROR');
  lines.push(`e_turn=${seed.mirror.e_turn ?? '(null)'}`);
  if (seed.mirror.basedOn) {
    lines.push(`basedOn=${seed.mirror.basedOn}`);
  }

  lines.push('');
  lines.push('POSITION');
  lines.push(`observedStage=${seed.position.observedStage ?? '(null)'}`);
  if (seed.position.primaryStage) {
    lines.push(`primaryStage=${seed.position.primaryStage}`);
  }
  if (seed.position.secondaryStage) {
    lines.push(`secondaryStage=${seed.position.secondaryStage}`);
  }

  return {
    mirrorFlowSeedText: lines.join('\n').trim(),
    writerDirectives: seed.writerDirectives,
    sourceOfTruth: seed.sourceOfTruth,
  };
}
