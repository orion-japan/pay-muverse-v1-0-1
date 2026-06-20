export type CognitionRelationCode =
  | 'S' // Self
  | 'F' // Fellow
  | 'R' // Roots
  | 'C' // Community
  | 'I' // Integration
  | 'P' // Project
  | 'U'; // Unknown

export type CognitionRelationDomain =
  | 'self'
  | 'fellow'
  | 'roots'
  | 'community'
  | 'integration'
  | 'project'
  | 'unknown';

export type CognitionProgress =
  | 'unstarted'
  | 'started'
  | 'transitioning'
  | 'settling'
  | 'completed'
  | 'unknown';

export type CognitionGodai =
  | 'earth' // 地 = 形
  | 'water' // 水 = 関係
  | 'fire' // 火 = 意志
  | 'wind' // 風 = 変化
  | 'void' // 空 = 可能性
  | null;

export type CognitionSanmitsu =
  | 'body' // 身 = 行動
  | 'speech' // 口 = 言葉
  | 'mind' // 意 = 認識
  | null;

export type CognitionGapState =
  | 'none'
  | 'exists'
  | 'unclear'
  | 'resolved'
  | 'unknown';

export type CognitionTriggerKind =
  | 'potential_gap'
  | 'expectation_gap'
  | 'direction_gap'
  | 'unintegrated'
  | 'stuck_point'
  | 'clarification_needed'
  | 'unknown';

export type CognitionMap = {
  version: 'cognition_map_v1';

  targetLabel: string | null;
  targetKey: string | null;

  relationCode: CognitionRelationCode;
  relationDomain: CognitionRelationDomain;

  currentPosition: string | null;
  destination: string | null;

  progress: CognitionProgress;

  gap: {
    state: CognitionGapState;
    text: string | null;
  };

  trigger: {
    kind: CognitionTriggerKind;
    text: string | null;
  };

  worldTags: {
    godai: CognitionGodai;
    sanmitsu: CognitionSanmitsu;
    juushin: string | null;
  };

  confidence: number;
  source: {
    kind:
      | 'user_text'
      | 'diagnosis_text'
      | 'relationship_memory'
      | 'person_context'
      | 'preseed'
      | 'unknown';
    text: string | null;
  };

  debug?: Record<string, any>;
};

export const COGNITION_RELATION_DOMAIN_BY_CODE: Record<
  CognitionRelationCode,
  CognitionRelationDomain
> = {
  S: 'self',
  F: 'fellow',
  R: 'roots',
  C: 'community',
  I: 'integration',
  P: 'project',
  U: 'unknown',
};

export function relationCodeToDomain(
  code: CognitionRelationCode | null | undefined,
): CognitionRelationDomain {
  if (!code) return 'unknown';
  return COGNITION_RELATION_DOMAIN_BY_CODE[code] ?? 'unknown';
}

export function normalizeCognitionProgress(input: string | null | undefined): CognitionProgress {
  const text = String(input ?? '').trim();

  if (!text) return 'unknown';

  if (/未開始|まだ始まっていない|始まってない/.test(text)) return 'unstarted';
  if (/開始|入口|始まり|始め/.test(text)) return 'started';
  if (/移行|変化中|途中|切り替/.test(text)) return 'transitioning';
  if (/定着|安定|馴染/.test(text)) return 'settling';
  if (/完成|完了|終わ/.test(text)) return 'completed';

  return 'unknown';
}

export function createEmptyCognitionMap(partial?: Partial<CognitionMap>): CognitionMap {
  const relationCode = partial?.relationCode ?? 'U';

  return {
    version: 'cognition_map_v1',

    targetLabel: partial?.targetLabel ?? null,
    targetKey: partial?.targetKey ?? null,

    relationCode,
    relationDomain: partial?.relationDomain ?? relationCodeToDomain(relationCode),

    currentPosition: partial?.currentPosition ?? null,
    destination: partial?.destination ?? null,

    progress: partial?.progress ?? 'unknown',

    gap: {
      state: partial?.gap?.state ?? 'unknown',
      text: partial?.gap?.text ?? null,
    },

    trigger: {
      kind: partial?.trigger?.kind ?? 'unknown',
      text: partial?.trigger?.text ?? null,
    },

    worldTags: {
      godai: partial?.worldTags?.godai ?? null,
      sanmitsu: partial?.worldTags?.sanmitsu ?? null,
      juushin: partial?.worldTags?.juushin ?? null,
    },

    confidence: partial?.confidence ?? 0,

    source: {
      kind: partial?.source?.kind ?? 'unknown',
      text: partial?.source?.text ?? null,
    },

    debug: partial?.debug,
  };
}

export function mergeCognitionMap(
  base: CognitionMap | null | undefined,
  patch: Partial<CognitionMap>,
): CognitionMap {
  const normalizedBase = base ?? createEmptyCognitionMap();
  const relationCode = patch.relationCode ?? normalizedBase.relationCode ?? 'U';

  return createEmptyCognitionMap({
    ...normalizedBase,
    ...patch,

    relationCode,
    relationDomain:
      patch.relationDomain ??
      normalizedBase.relationDomain ??
      relationCodeToDomain(relationCode),

    gap: {
      ...normalizedBase.gap,
      ...(patch.gap ?? {}),
    },

    trigger: {
      ...normalizedBase.trigger,
      ...(patch.trigger ?? {}),
    },

    worldTags: {
      ...normalizedBase.worldTags,
      ...(patch.worldTags ?? {}),
    },

    source: {
      ...normalizedBase.source,
      ...(patch.source ?? {}),
    },

    debug: {
      ...(normalizedBase.debug ?? {}),
      ...(patch.debug ?? {}),
    },
  });
}

export function cognitionMapToSeedText(map: CognitionMap | null | undefined): string {
  if (!map) return '';

  return [
    'COGNITION_MAP_V1 (DO NOT OUTPUT):',
    `targetLabel=${map.targetLabel ?? '(null)'}`,
    `targetKey=${map.targetKey ?? '(null)'}`,
    `relationCode=${map.relationCode}`,
    `relationDomain=${map.relationDomain}`,
    `currentPosition=${map.currentPosition ?? '(null)'}`,
    `destination=${map.destination ?? '(null)'}`,
    `progress=${map.progress}`,
    `gapState=${map.gap.state}`,
    `gapText=${map.gap.text ?? '(null)'}`,
    `triggerKind=${map.trigger.kind}`,
    `triggerText=${map.trigger.text ?? '(null)'}`,
    `godai=${map.worldTags.godai ?? '(null)'}`,
    `sanmitsu=${map.worldTags.sanmitsu ?? '(null)'}`,
    `juushin=${map.worldTags.juushin ?? '(null)'}`,
    `confidence=${map.confidence}`,
    `sourceKind=${map.source.kind}`,
  ].join('\n');
}
