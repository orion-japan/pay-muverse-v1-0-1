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
  lines.push(`continuity=${seed.sourceOfTruth.continuity}`);
  lines.push(`motion=${seed.sourceOfTruth.motion}`);

  lines.push('');
  lines.push('MIRROR');
  lines.push(`e_turn=${seed.mirror.e_turn ?? '(null)'}`);
  lines.push(`polarity=${seed.mirror.polarity ?? '(null)'}`);
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

  lines.push('');
  lines.push('CONTINUITY');
  lines.push(`depthStage=${seed.continuity.depthStage ?? '(null)'}`);
  lines.push(
    `depthHistory=${seed.continuity.depthHistoryLite.length > 0 ? seed.continuity.depthHistoryLite.join('→') : '(none)'}`,
  );

  lines.push('');
  lines.push('MOTION');
  lines.push(`axis=${seed.motion.axis ?? '(null)'}`);
  lines.push(`kind=${seed.motion.kind ?? '(null)'}`);
  if (seed.motion.reason) {
    lines.push(`reason=${seed.motion.reason}`);
  }
  if (seed.motion.suggestedStage) {
    lines.push(`suggestedStage=${seed.motion.suggestedStage}`);
  }

  lines.push('');
  lines.push('OPENNESS');
  lines.push(`tLayerHint=${seed.openness.tLayerHint ?? '(null)'}`);
  lines.push(
    `itOk=${seed.openness.itOk === null ? '(null)' : String(seed.openness.itOk)}`,
  );

  lines.push('');
  lines.push('META');
  lines.push(`qCode=${seed.meta.qCode ?? '(null)'}`);
  lines.push(`flowDelta=${seed.meta.flowDelta ?? '(null)'}`);

  lines.push('');
  lines.push('WRITER_DIRECTIVES');
  lines.push(`tone=${seed.writerDirectives.tone ?? '(null)'}`);
  lines.push(
    `maxLines=${seed.writerDirectives.maxLines == null ? '(null)' : String(seed.writerDirectives.maxLines)}`,
  );
  lines.push(`slotPolicy=${seed.writerDirectives.slotPolicy ?? '(null)'}`);
  lines.push(`rotationMention=${seed.writerDirectives.rotationMention ?? '(null)'}`);

  return {
    mirrorFlowSeedText: lines.join('\n').trim(),
    writerDirectives: seed.writerDirectives,
    sourceOfTruth: seed.sourceOfTruth,
  };
}
