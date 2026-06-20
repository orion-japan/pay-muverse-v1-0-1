import type { MemorySpace, ResolvedRelation, ResolvedTarget, SourceAuthority } from './types';

export type GuardedMemorySource = {
  status: 'ok' | 'ambiguous' | 'not_found' | 'rejected';
  reason: string;
  sourceAuthority: SourceAuthority;
  sourceKind: string | null;
  sourceId: string | number | null;
  sourceText: string | null;
  raw?: any;
};

export function guardMemorySource(args: {
  memorySpace: MemorySpace;
  source: GuardedMemorySource;
  resolvedTarget?: ResolvedTarget | null;
  resolvedRelation?: ResolvedRelation | null;
}): GuardedMemorySource {
  const source = args.source;

  if (!source || source.status !== 'ok') return source;

  const targetKey = args.resolvedTarget?.targetKey ?? null;
  const relationTargetKey = args.resolvedRelation?.targetKey ?? null;

  const rawTargetKey =
    source.raw?.target_key ??
    source.raw?.targetKey ??
    source.raw?.target_label ??
    source.raw?.targetLabel ??
    null;

  if (rawTargetKey && targetKey) {
    const a = String(rawTargetKey).trim().toLowerCase();
    const b = String(targetKey).trim().toLowerCase();

    if (a && b && a !== b) {
      return {
        ...source,
        status: 'rejected',
        reason: 'target_mismatch',
        sourceText: null,
      };
    }
  }

  if (args.memorySpace === 'relationship' && relationTargetKey && rawTargetKey) {
    const a = String(rawTargetKey).trim().toLowerCase();
    const b = String(relationTargetKey).trim().toLowerCase();

    if (a && b && a !== b) {
      return {
        ...source,
        status: 'rejected',
        reason: 'relation_target_mismatch',
        sourceText: null,
      };
    }
  }

  return source;
}
