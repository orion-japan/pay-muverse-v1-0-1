export type RelationshipIdentity = {
  targetLabel: string;
  displayName: string;
  personId: string;
  relationId: string;
  referenceTarget: string;
};

export type RelationshipIdentityInput = {
  targetLabel?: string | null;
  displayName?: string | null;
  personId?: string | null;
  relationId?: string | null;
  referenceTarget?: string | null;
  kind?: string | null;
  status?: string | null;
  confidence?: string | null;
  alias?: string[] | null;
  relationshipContext?: any;
  relationshipCapture?: any;
};

const PENDING_LOVE_LABELS = new Set([
  '好きな人',
  '気になる人',
  '気になっている相手',
  '片思いの相手',
]);

const LOVE_KINDS = new Set([
  'one_sided_love',
  'romantic_interest',
  'relationship_context',
]);

export function normalizePersonName(input: string): string {
  return String(input ?? '')
    .replace(/\s+/g, '')
    .trim();
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export function buildPendingLoveInterestIdentity(userCode: string): RelationshipIdentity {
  return {
    personId: 'person_pending_love_interest',
    relationId: `${userCode}__person_pending_love_interest`,
    displayName: '気になっている相手',
    targetLabel: '気になっている相手',
    referenceTarget: '気になっている相手',
  };
}

export function buildNamedPersonIdentity(userCode: string, name: string): RelationshipIdentity {
  const normalizedName = normalizePersonName(name);

  return {
    personId: `person_${normalizedName}`,
    relationId: `${userCode}__person_${normalizedName}`,
    displayName: normalizedName,
    targetLabel: normalizedName,
    referenceTarget: normalizedName,
  };
}

export function shouldUsePendingLoveInterestIdentity(input: {
  targetLabel?: string | null;
  kind?: string | null;
}): boolean {
  const targetLabel = normalizePersonName(String(input.targetLabel ?? ''));
  const kind = String(input.kind ?? '').trim();

  if (!targetLabel) return false;

  if (PENDING_LOVE_LABELS.has(targetLabel)) return true;

  // 「相手」単独は誤爆しやすいので、恋愛文脈がある時だけ pending に寄せる
  if (targetLabel === '相手' && LOVE_KINDS.has(kind)) return true;

  return false;
}

export function enrichRelationshipIdentity<T extends RelationshipIdentityInput>(
  raw: T,
  userCode: string,
): T & {
  targetLabel: string;
  displayName: string;
  personId: string;
  relationId: string;
  referenceTarget: string;
  kind: string;
  status: string;
  confidence: string;
  relationshipContext: any;
  relationshipCapture: any;
} {
  const targetLabel =
    pickString(
      raw?.targetLabel,
      raw?.relationshipContext?.targetLabel,
      raw?.relationshipCapture?.targetLabel,
    ) ?? '気になっている相手';

  const kind =
    pickString(
      raw?.kind,
      raw?.relationshipContext?.kind,
      raw?.relationshipCapture?.kind,
    ) ?? 'one_sided_love';

  const identity = shouldUsePendingLoveInterestIdentity({ targetLabel, kind })
    ? buildPendingLoveInterestIdentity(userCode)
    : buildNamedPersonIdentity(userCode, targetLabel);

  const status =
    pickString(
      raw?.status,
      raw?.relationshipContext?.status,
      raw?.relationshipCapture?.status,
    ) ?? 'confirmed_by_user';

  const confidence =
    pickString(
      raw?.confidence,
      raw?.relationshipContext?.confidence,
      raw?.relationshipCapture?.confidence,
    ) ?? 'high';

  return {
    ...raw,
    ...identity,
    kind,
    status,
    confidence,
    relationshipContext: {
      ...(raw?.relationshipContext ?? {}),
      ...identity,
      kind,
      status,
      confidence,
    },
    relationshipCapture: {
      ...(raw?.relationshipCapture ?? {}),
      ...identity,
      kind,
      status,
      confidence,
    },
  };
}