import { normalizeDiagnosisTargetKey } from './normalizeDiagnosisTargetKey';

export type MemoryIntent =
  | 'diagnosis_recall'
  | 'relationship_recall'
  | 'person_state_recall'
  | 'project_context_recall'
  | 'working_rule_recall'
  | 'past_context_recall'
  | 'current_state_recall'
  | 'no_memory';

export type MemorySpace =
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
  | 'deep_recognition';

export type MemoryRouterDecision = {
  memoryIntent: MemoryIntent;
  memorySpace: MemorySpace;
  targetLabel: string | null;
  targetKey: string | null;
  projectKey: string | null;
  relationId: string | null;
  recallMode: MemoryRecallMode;
  confidence: number;
  reason: string;
};

export type RouteIrosMemoryArgs = {
  userText: string;
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

export function routeIrosMemory(args: RouteIrosMemoryArgs): MemoryRouterDecision {
  const userText = String(args.userText ?? '').trim();

  const diagnosisTargetLabel = extractDiagnosisRecallTargetLabel(userText);
  const diagnosisTargetKey = normalizeDiagnosisTargetKey(diagnosisTargetLabel);

  const hasDiagnosisRecallWord =
    /(診断結果|診断内容|前の診断|さっきの診断|この診断|ir診断|IR診断|診断を元に|診断をもとに|診断に基づ|診断ベース|診断から)/u.test(
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
      confidence: wantsDeepen ? 0.92 : 0.86,
      reason: 'target_name_and_diagnosis_recall_word',
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
    confidence: 0,
    reason: 'no_memory_route_matched',
  };
}
