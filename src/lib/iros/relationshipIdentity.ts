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

const INVALID_PERSON_TARGET_FRAGMENT_RE =
  /(ても|でも|けど|から|なら|ので|ため|こと|感じ|状態|気持ち|返事|好意|脈あり|ただ優しい|動いている|分からない|わからない|会うため|日程|代案|具体|可能性|段階|様子見|こちらの出方|距離|やり取り|誘い|誘い方|見極め)/u;

const GENERIC_RELATIONSHIP_TARGETS = new Set([
  '相手',
  'その相手',
  'その人',
  '好きな人',
  '気になる人',
  '気になっている相手',
  '片思いの相手',
]);

function stripOuterQuotes(input: string): string {
  return input
    .replace(/^「(.+)」$/u, '$1')
    .replace(/^『(.+)』$/u, '$1')
    .trim();
}

export function isInvalidPersonTargetLabel(input: string | null | undefined): boolean {
  const raw = String(input ?? '').trim();
  if (!raw) return true;

  const stripped = stripOuterQuotes(raw);
  if (!stripped) return true;

  // 引用符付きの文章断片は人名にしない
  if ((/^「.+」$/u.test(raw) || /^『.+』$/u.test(raw)) && INVALID_PERSON_TARGET_FRAGMENT_RE.test(stripped)) {
    return true;
  }

  // 文・条件・状態っぽい断片は人名にしない
  if (INVALID_PERSON_TARGET_FRAGMENT_RE.test(stripped)) {
    return true;
  }

  // 助詞や句読点を含む長い断片は人名にしない
  if (/[、。！？!?]/u.test(stripped)) return true;
  if ([...stripped].length > 12 && /(は|が|を|に|で|と|から|まで|より|って)/u.test(stripped)) {
    return true;
  }

  return false;
}

export function sanitizeRelationshipTargetLabel(input: string | null | undefined, kind?: string | null): string {
  const raw = normalizePersonName(stripOuterQuotes(String(input ?? '').trim()));
  const kindText = String(kind ?? '').trim();

  if (!raw) return LOVE_KINDS.has(kindText) ? '気になっている相手' : '相手';

  if (GENERIC_RELATIONSHIP_TARGETS.has(raw)) {
    return raw === '相手' && LOVE_KINDS.has(kindText) ? '気になっている相手' : raw;
  }

  if (isInvalidPersonTargetLabel(raw)) {
    return LOVE_KINDS.has(kindText) ? '気になっている相手' : '相手';
  }

  return raw;
}

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
  const rawTargetLabel =
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

  const targetLabel = sanitizeRelationshipTargetLabel(rawTargetLabel, kind);

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