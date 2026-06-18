import type { ResolvedRelation, ResolvedTarget } from './types';

export function buildRelationId(userCode: string | null | undefined, targetKey: string | null | undefined): string | null {
  const u = String(userCode ?? '').trim();
  const t = String(targetKey ?? '').trim();

  if (!u || !t) return null;

  return `${u}__person_${t}`;
}

export async function resolveRelationForPreSeed(args: {
  userText: string;
  resolvedTarget: ResolvedTarget | null;
  userCode?: string | null;
  supabase?: any;
}): Promise<ResolvedRelation> {
  const text = String(args.userText ?? '').trim();
  const targetKey = args.resolvedTarget?.targetKey ?? null;
  const label = args.resolvedTarget?.label ?? null;

  const relationLike = /(関係|距離感|仲|相性|恋愛|相手|彼|彼女|夫|妻|母|父|子供|友達|クライアント|先生|弟子)/u.test(text);

  if (!relationLike || !targetKey) {
    return {
      status: 'not_found',
      relationId: null,
      displayName: null,
      selfLabel: null,
      otherLabel: null,
      targetKey: null,
      relationRole: 'unknown',
      confidence: 0,
      source: 'none',
    };
  }

  return {
    status: 'resolved',
    relationId: buildRelationId(args.userCode, targetKey),
    displayName: label,
    selfLabel: 'user',
    otherLabel: label,
    targetKey,
    relationRole: 'unknown',
    confidence: 0.72,
    source: 'explicit_user_text',
  };
}
