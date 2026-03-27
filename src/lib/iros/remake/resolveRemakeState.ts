export type RemakeKind =
  | 'none'
  | 'self_blame_to_structure'
  | 'fear_to_signal'
  | 'confusion_to_readable_state'
  | 'stuck_to_next_step';

export type ResolveRemakeStateInput = {
  goalKind?: string | null;
  targetKind?: string | null;

  userText?: string | null;
  assistantText?: string | null;

  seedMeaning?: string | null;
  seedDelta?: string | null;
  focusText?: string | null;

  observedStage?: string | null;
  depthStage?: string | null;
};

export type ResolveRemakeStateResult = {
  detected: boolean;
  kind: RemakeKind;

  fromLabel: string | null;
  toLabel: string | null;

  confidence: number;
  reasons: string[];

  at: string | null;
};

function norm(v: unknown): string {
  return String(v ?? '').trim();
}

function normLower(v: unknown): string {
  return norm(v).toLowerCase();
}

function normalizeText(v: unknown): string {
  return norm(v).replace(/\s+/g, ' ').trim().toLowerCase();
}

function hasAny(text: string, parts: string[]): boolean {
  if (!text) return false;
  return parts.some((p) => p && text.includes(p));
}

function detectFromLabel(userText: string): string | null {
  if (
    hasAny(userText, [
      '自分が変',
      '私が変',
      '自分がおかしい',
      '私がおかしい',
      '自分のせい',
      '私のせい',
      '自分が悪い',
      '私が悪い',
    ])
  ) {
    return 'self_blame';
  }

  if (
    hasAny(userText, [
      '距離がわからない',
      '距離感がわからない',
      'どう接していいかわからない',
      'どうしたらいいかわからない',
      '何が正解かわからない',
      'わからない',
      '迷う',
      '不安',
    ])
  ) {
    return 'confused_or_unreadable';
  }

  if (
    hasAny(userText, [
      '怖い',
      '恐い',
      '不安',
      '嫌われ',
      '重いかも',
      '近づきすぎ',
      '冷たく見えた',
    ])
  ) {
    return 'fear_or_threat';
  }

  if (
    hasAny(userText, [
      '止まってる',
      '動けない',
      '進めない',
      '固まる',
    ])
  ) {
    return 'stuck';
  }

  return null;
}

function detectToLabel(assistantText: string): string | null {
  if (
    hasAny(assistantText, [
      '判断材料が足りない',
      '材料が足りない',
      '状況で迷ってるだけ',
      '構造',
      '読み',
      '読みのフレーム',
      '反応で確かめる',
      '手がかり',
      '証拠',
    ])
  ) {
    return 'structure_read';
  }

  if (
    hasAny(assistantText, [
      '次の一歩',
      '一つだけ',
      'まずは',
      '混ぜてみて',
      '確かめる',
      '試してみて',
    ])
  ) {
    return 'next_step';
  }

  if (
    hasAny(assistantText, [
      '信号',
      'サイン',
      '合図',
      '手がかり',
    ])
  ) {
    return 'signal_read';
  }

  return null;
}

function detectKind(fromLabel: string | null, toLabel: string | null): RemakeKind {
  if (fromLabel === 'self_blame' && toLabel === 'structure_read') {
    return 'self_blame_to_structure';
  }

  if (fromLabel === 'fear_or_threat' && toLabel === 'signal_read') {
    return 'fear_to_signal';
  }

  if (fromLabel === 'confused_or_unreadable' && toLabel === 'structure_read') {
    return 'confusion_to_readable_state';
  }

  if (fromLabel === 'stuck' && toLabel === 'next_step') {
    return 'stuck_to_next_step';
  }

  return 'none';
}

export function resolveRemakeState(
  input: ResolveRemakeStateInput,
): ResolveRemakeStateResult {
  const reasons: string[] = [];

  const goalKind = normLower(input.goalKind);
  const targetKind = normLower(input.targetKind);

  const userText = normalizeText(
    [input.userText, input.focusText].filter(Boolean).join('\n')
  );

  const assistantText = normalizeText(
    [input.assistantText, input.seedMeaning, input.seedDelta]
      .filter(Boolean)
      .join('\n')
  );

  const fromLabel = detectFromLabel(userText);
  const toLabel = detectToLabel(assistantText);

  const goalSupportsRemake =
    goalKind === 'uncover' ||
    targetKind === 'uncover' ||
    goalKind === 'resonate' ||
    targetKind === 'resonate';

  if (goalSupportsRemake) reasons.push('goal_supports_remake');
  if (fromLabel) reasons.push(`from:${fromLabel}`);
  if (toLabel) reasons.push(`to:${toLabel}`);

  const kind = detectKind(fromLabel, toLabel);
  if (kind !== 'none') reasons.push(`kind:${kind}`);

  let confidence = 0;
  if (goalSupportsRemake) confidence += 0.25;
  if (fromLabel) confidence += 0.25;
  if (toLabel) confidence += 0.25;
  if (kind !== 'none') confidence += 0.25;

  const detected = kind !== 'none' && confidence >= 0.75;

  return {
    detected,
    kind: detected ? kind : 'none',
    fromLabel,
    toLabel,
    confidence: Number(confidence.toFixed(2)),
    reasons,
    at: new Date().toISOString(),
  };
}
