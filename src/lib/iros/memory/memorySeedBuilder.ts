import type { MemoryRouterDecision } from './memoryRouter';
import type { MemoryGuardDecision } from './memoryGuard';

export type BuildMemorySeedArgs = {
  memoryDecision: MemoryRouterDecision;
  memoryGuardDecision: MemoryGuardDecision;
  sourceText?: string | null;
  diagnosisText?: string | null;
  relationshipText?: string | null;
  pastContextText?: string | null;
  longTermText?: string | null;
};

export type MemorySeedResult = {
  hasSeed: boolean;
  seedText: string | null;
  seedKind: string | null;
  blocked: boolean;
  reasons: string[];
};

function normalizeSeedString(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s.length > 0 ? s : null;
}

function line(key: string, value: unknown): string {
  return `${key}=${normalizeSeedString(value) ?? 'null'}`;
}

function buildBaseLines(args: BuildMemorySeedArgs, seedKind: string): string[] {
  const { memoryDecision, memoryGuardDecision } = args;

  return [
    'MEMORY_SEED (DO NOT OUTPUT)',
    line('seedKind', seedKind),
    line('memoryIntent', memoryDecision.memoryIntent),
    line('memorySpace', memoryDecision.memorySpace),
    line('recallMode', memoryDecision.recallMode),
    line('targetLabel', memoryDecision.targetLabel),
    line('targetKey', memoryDecision.targetKey),
    line('projectKey', memoryDecision.projectKey),
    line('relationId', memoryDecision.relationId),
    line('confidence', memoryDecision.confidence),
    line('reason', memoryDecision.reason),
    line('guardReasons', memoryGuardDecision.guardReasons.join(',')),
    line('allowWriterSeed', memoryGuardDecision.allowWriterSeed),
    line('allowLongTermSave', memoryGuardDecision.allowLongTermSave),
    line('allowPastStateMerge', memoryGuardDecision.allowPastStateMerge),
    line('allowDiagnosisSave', memoryGuardDecision.allowDiagnosisSave),
    line('allowRelationshipSave', memoryGuardDecision.allowRelationshipSave),
  ];
}

export function buildMemorySeed(args: BuildMemorySeedArgs): MemorySeedResult {
  const { memoryDecision, memoryGuardDecision } = args;
  const reasons = [...memoryGuardDecision.guardReasons];

  if (!memoryGuardDecision.allowWriterSeed) {
    return {
      hasSeed: false,
      seedText: null,
      seedKind: null,
      blocked: true,
      reasons: reasons.length > 0 ? reasons : ['writer_seed_not_allowed'],
    };
  }

  if (memoryDecision.memoryIntent === 'diagnosis_recall') {
    const diagnosisText = normalizeSeedString(args.diagnosisText ?? args.sourceText);

    const lines = [
      ...buildBaseLines(args, 'DIAGNOSIS_MEMORY_SEED'),
      'source=diagnosis_memory',
      'boundary=保存済みのir診断結果だけを扱う。外部の診断書や本人だけが持つ事実として断定しない。',
      'writerTask=保存済み診断を正本として、ユーザーの続きの要求に答える。',
      line('diagnosisText', diagnosisText),
    ];

    return {
      hasSeed: true,
      seedText: lines.join('\n'),
      seedKind: 'diagnosis',
      blocked: false,
      reasons,
    };
  }

  if (memoryDecision.memoryIntent === 'relationship_recall') {
    const relationshipText = normalizeSeedString(args.relationshipText ?? args.sourceText);

    const lines = [
      ...buildBaseLines(args, 'RELATIONSHIP_MEMORY_SEED'),
      'source=relationship_memory',
      'boundary=保存済みの関係文脈だけを扱う。相手の本音・愛情・未練・脈あり脈なしは断定しない。',
      'writerTask=保存済みの関係文脈を補助線として、いまの相談に答える。',
      line('relationshipText', relationshipText),
    ];

    return {
      hasSeed: true,
      seedText: lines.join('\n'),
      seedKind: 'relationship',
      blocked: false,
      reasons,
    };
  }

  if (memoryDecision.memoryIntent === 'reference_check') {
    const referenceText = normalizeSeedString(args.sourceText);

    const lines = [
      ...buildBaseLines(args, 'REFERENCE_MEMORY_SEED'),
      'source=current_turn_working_reference',
      'boundary=このターン内の参照解決だけに使う。長期記憶・診断Memory・関係Memoryへ保存しない。',
      'writerTask=ユーザーの「あれ／これ／その人」などの参照先を補助して返答する。',
      line('referenceText', referenceText),
    ];

    return {
      hasSeed: true,
      seedText: lines.join('\n'),
      seedKind: 'reference',
      blocked: false,
      reasons,
    };
  }

  const pastContextText = normalizeSeedString(args.pastContextText ?? args.sourceText);
  const longTermText = normalizeSeedString(args.longTermText);

  const lines = [
    ...buildBaseLines(args, 'GENERAL_MEMORY_SEED'),
    'source=guarded_memory_context',
    'boundary=Guardを通過した記憶だけを補助文脈として扱う。記憶内容を事実として過剰に断定しない。',
    'writerTask=現在のユーザー入力に必要な範囲だけ、記憶文脈を補助として使う。',
    line('pastContextText', pastContextText),
    line('longTermText', longTermText),
  ];

  return {
    hasSeed: true,
    seedText: lines.join('\n'),
    seedKind: 'general',
    blocked: false,
    reasons,
  };
}