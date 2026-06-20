import type {
  MemoryIntent,
  MemorySpace,
  ResolvedRelation,
  ResolvedTarget,
  SourceAuthority,
} from './types';

export function buildUniversalSeed(args: {
  userText: string;
  memoryIntent: MemoryIntent;
  memorySpace: MemorySpace;
  sourceAuthority: SourceAuthority;
  sourceText?: string | null;
  resolvedTarget?: ResolvedTarget | null;
  resolvedRelation?: ResolvedRelation | null;
}): string {
  return [
    'UNIVERSAL_PRE_SEED (DO NOT OUTPUT):',
    `memoryIntent=${args.memoryIntent}`,
    `memorySpace=${args.memorySpace}`,
    `sourceAuthority=${args.sourceAuthority}`,
    `userText=${String(args.userText ?? '').trim()}`,
    `targetLabel=${args.resolvedTarget?.label ?? ''}`,
    `targetKey=${args.resolvedTarget?.targetKey ?? ''}`,
    `relationId=${args.resolvedRelation?.relationId ?? ''}`,
    '',
    'RULES:',
    'Writerは記憶を選ばない。',
    'Writerは参照語を解決しない。',
    'WriterはsourceTextを正本として扱う。',
    'WriterはtargetKeyを変更しない。',
    'Writerは他人物の記憶を混ぜない。',
    'WriterはpastStateNoteTextを正本にしない。',
    'Writerは不明な記憶を見たふりしない。',
    '',
    'SOURCE_TEXT:',
    String(args.sourceText ?? '').trim(),
  ].join('\n');
}
