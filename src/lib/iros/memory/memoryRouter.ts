import { normalizeDiagnosisTargetKey } from './normalizeDiagnosisTargetKey';
import type { WorkingReference } from './workingReferenceResolver';

export type MemoryIntent =
  | 'reference_check'
  | 'diagnosis_recall'
  | 'relationship_recall'
  | 'person_state_recall'
  | 'project_context_recall'
  | 'working_rule_recall'
  | 'past_context_recall'
  | 'current_state_recall'
  | 'no_memory';

export type MemorySpace =
  | 'working'
  | 'diagnosis'
  | 'relationship'
  | 'development'
  | 'project'
  | 'creative'
  | 'general'
  | 'temporary';

export type MemoryRecallMode =
  | 'off'
  | 'explicit'
  | 'contextual'
  | 'deep_recognition'
  | 'current_turn';

export type MemoryRouterDecision = {
  memoryIntent: MemoryIntent;
  memorySpace: MemorySpace;
  targetLabel: string | null;
  targetKey: string | null;
  projectKey: string | null;
  relationId: string | null;
  recallMode: MemoryRecallMode;
  workingReference: WorkingReference | null;
  confidence: number;
  reason: string;
};

export type RouteIrosMemoryArgs = {
  userText: string;
  workingReference?: WorkingReference | null;
};

function cleanTargetLabel(value: unknown): string | null {
  const s = String(value ?? '')
    .replace(/[\s　]+/g, ' ')
    .trim();

  if (!s) return null;

  const cleaned = s
    .replace(/^(ir診断|IR診断|診断)\s*/u, '')
    .replace(/(について|に関して)$/u, '')
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}

function isDeicticRelationshipTarget(value: unknown): boolean {
  const s = String(value ?? '')
    .replace(/[\s　]+/g, '')
    .trim();

  return /^(彼|彼氏|彼女|相手|あの人|あのひと|好きな人|恋人|元彼|元カレ|元彼女|元カノ)$/u.test(s);
}

function extractDiagnosisRecallTargetLabel(userText: string): string | null {
  const text = String(userText ?? '')
    .replace(/[\s　]+/g, ' ')
    .trim();

  if (!text) return null;

  const patterns: RegExp[] = [
    /^(.+?)の(?:診断結果|診断内容|診断|ir診断|IR診断)/u,
    /^(.+?)について(?:診断結果|診断内容|診断|ir診断|IR診断)/u,
    /^(.+?)(?:の)?(?:状態|結果)を(?:深めて|深める|掘り下げ|詳しく)/u,
  ];

  for (const pattern of patterns) {
    const matched = text.match(pattern);
    const picked = cleanTargetLabel(matched?.[1] ?? null);
    if (picked) return picked;
  }

  return null;
}

function extractRelationshipTargetLabel(userText: string): string | null {
  const text = String(userText ?? '')
    .replace(/[\s　]+/g, ' ')
    .trim();

  if (!text) return null;

  const patterns: RegExp[] = [
    /^(.+?)との(?:関係|関係性|距離感|ズレ|ずれ)/u,
    /^(.+?)の(?:関係|関係性|距離感|ズレ|ずれ)/u,
    /^(.+?)について(?:関係|関係性|距離感|ズレ|ずれ)/u,
    /^(.+?)と(?:前と変わった|どう見れば|どう扱えば|どう向き合えば)/u,
  ];

  for (const pattern of patterns) {
    const matched = text.match(pattern);
    const picked = cleanTargetLabel(matched?.[1] ?? null);
    if (picked) return picked;
  }

  const deictic = text.match(/^(彼|彼氏|彼女|相手|あの人|あのひと|好きな人|恋人|元彼|元カレ|元彼女|元カノ)(?:との|の)?(?:関係|関係性|距離感|ズレ|ずれ|前と変わった|どう見れば|どう扱えば|どう向き合えば)/u);
  const picked = cleanTargetLabel(deictic?.[1] ?? null);
  return picked;
}

export function routeIrosMemory(args: RouteIrosMemoryArgs): MemoryRouterDecision {
  const userText = String(args.userText ?? '').trim();
  const workingReference = args.workingReference ?? null;

  if (workingReference) {
    return {
      memoryIntent: 'reference_check',
      memorySpace: 'working',
      targetLabel: workingReference.referenceTarget,
      targetKey: null,
      projectKey: null,
      relationId: null,
      recallMode: 'current_turn',
      workingReference,
      confidence: workingReference.confidence,
      reason: 'working_reference_resolved',
    };
  }

  const diagnosisTargetLabel = extractDiagnosisRecallTargetLabel(userText);
  const diagnosisTargetKey = normalizeDiagnosisTargetKey(diagnosisTargetLabel);

  const relationshipTargetLabel = extractRelationshipTargetLabel(userText);
  const relationshipTargetKey = isDeicticRelationshipTarget(relationshipTargetLabel)
    ? null
    : normalizeDiagnosisTargetKey(relationshipTargetLabel);

  const hasDiagnosisRecallWord =
    /(診断結果|診断内容|前の診断|さっきの診断|この診断|ir診断|IR診断|診断を元に|診断をもとに|診断に基づ|診断ベース|診断から)/u.test(
      userText
    );

  const hasRelationshipRecallWord =
    /(関係|関係性|距離感|ズレ|ずれ|前と変わった|どう見れば|どう扱えば|どう向き合えば)/u.test(
      userText
    );

  const wantsDeepen =
    /(深めて|深める|掘り下げ|掘って|詳しく|もう少し深く|理由|なぜ)/u.test(
      userText
    );

  if (diagnosisTargetKey && hasDiagnosisRecallWord) {
    return {
      memoryIntent: 'diagnosis_recall',
      memorySpace: 'diagnosis',
      targetLabel: diagnosisTargetLabel,
      targetKey: diagnosisTargetKey,
      projectKey: null,
      relationId: null,
      recallMode: wantsDeepen ? 'deep_recognition' : 'contextual',
      workingReference: null,
      confidence: wantsDeepen ? 0.92 : 0.86,
      reason: 'target_name_and_diagnosis_recall_word',
    };
  }

  if (relationshipTargetLabel && hasRelationshipRecallWord) {
    return {
      memoryIntent: 'relationship_recall',
      memorySpace: 'relationship',
      targetLabel: relationshipTargetLabel,
      targetKey: relationshipTargetKey,
      projectKey: null,
      relationId: null,
      recallMode: wantsDeepen ? 'deep_recognition' : 'contextual',
      workingReference: null,
      confidence: relationshipTargetKey ? 0.84 : 0.72,
      reason: relationshipTargetKey
        ? 'target_name_and_relationship_recall_word'
        : 'deictic_relationship_recall_word',
    };
  }

  return {
    memoryIntent: 'no_memory',
    memorySpace: 'general',
    targetLabel: null,
    targetKey: null,
    projectKey: null,
    relationId: null,
    recallMode: 'off',
    workingReference: null,
    confidence: 0,
    reason: 'no_memory_route_matched',
  };
}

