// src/lib/iros/relationship/relationshipAnalysis.ts
// iros — Relationship Layer v1.0 (analysis)
// 恋愛・人間関係の無意識反応を軽く推定する

import type {
  AttachmentHint,
  ProjectionFlag,
} from './relationshipTypes';

export type BuildRelationshipAnalysisArgs = {
  userText: string;
  historyText?: string | null;
  topicDigest?: string | null;
  emotionalTemperature?: string | null;
  intentLabel?: string | null;
};

export type RelationshipAnalysis = {
  attachment_hint: AttachmentHint | null;
  projection_flag: ProjectionFlag | null;
  impulse_kind: string | null;
  self_value_shake: boolean;
  pursuit_risk: 'low' | 'mid' | 'high' | null;
};

function normalizeLite(value: unknown): string {
  return String(value ?? '').trim();
}

function lowerLite(value: unknown): string {
  return normalizeLite(value).toLowerCase();
}

function includesAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

function detectAttachmentHint(text: string): AttachmentHint | null {
  if (!text) return null;

  if (
    includesAny(text, [
      '追いline',
      '追いライン',
      '追いメッセージ',
      'すぐ返してほしい',
      'なんで返信くれない',
      '不安で何度も見',
      '嫌われたかも',
    ])
  ) {
    return 'anxious';
  }

  if (
    includesAny(text, [
      '距離を置きたい',
      'もう関わりたくない',
      '避けたい',
      '離れたい',
      '返信したくない',
    ])
  ) {
    return 'avoid';
  }

  if (
    includesAny(text, [
      '追いたい',
      'なんとかしたい',
      'こちらから動きたい',
      '取り戻したい',
    ])
  ) {
    return 'pursue';
  }

  if (
    includesAny(text, [
      '落ち着いて見たい',
      '冷静に見たい',
      '急がずに見たい',
      '整えて考えたい',
    ])
  ) {
    return 'secure';
  }

  return 'unknown';
}

function detectProjectionFlag(text: string): ProjectionFlag | null {
  if (!text) return null;

  if (
    includesAny(text, [
      '嫌われた',
      '私に価値がない',
      '自分がだめ',
      '私が悪い',
    ])
  ) {
    return 'self_doubt';
  }

  if (
    includesAny(text, [
      'こう思ってるはず',
      '絶対に嫌がってる',
      '本当は嫌い',
      '相手はこう考えてる',
    ])
  ) {
    return 'mind_reading';
  }

  if (
    includesAny(text, [
      'もう終わり',
      '全部だめ',
      '完全に無理',
      '一生このまま',
    ])
  ) {
    return 'catastrophizing';
  }

  if (
    includesAny(text, [
      'あの人は完璧',
      '特別すぎる',
      '他の人と違う',
      '理想すぎる',
    ])
  ) {
    return 'idealization';
  }

  if (
    includesAny(text, [
      'いつもそう',
      '毎回こう',
      '誰もわかってくれない',
      '全部同じ',
    ])
  ) {
    return 'generalization';
  }

  return null;
}

function detectImpulseKind(text: string): string | null {
  if (!text) return null;

  if (
    includesAny(text, [
      '今すぐ送りたい',
      'すぐ連絡したい',
      '追いlineしたい',
      '追いラインしたい',
      '送ってしまいそう',
    ])
  ) {
    return 'chase_message';
  }

  if (
    includesAny(text, [
      '確認したい',
      '気持ちを聞きたい',
      'はっきりさせたい',
      '答えを求めたい',
    ])
  ) {
    return 'confirmation_request';
  }

  if (
    includesAny(text, [
      '試したい',
      '駆け引きしたい',
      '反応を見たい',
      'わざと距離を置きたい',
    ])
  ) {
    return 'control_test';
  }

  return null;
}

function detectSelfValueShake(text: string): boolean {
  if (!text) return false;

  return includesAny(text, [
    '自分に価値がない',
    '私じゃだめ',
    '選ばれない',
    '愛されない',
    '足りない気がする',
    '自信がない',
  ]);
}

function detectPursuitRisk(text: string, emotionalTemperature: string): 'low' | 'mid' | 'high' | null {
  if (!text) return null;

  const hot = includesAny(emotionalTemperature, ['high', 'volatile']);

  if (
    hot &&
    includesAny(text, [
      '今すぐ送りたい',
      '追いline',
      '追いライン',
      '何度も送りたい',
      '返事を迫りたい',
    ])
  ) {
    return 'high';
  }

  if (
    includesAny(text, [
      '送りたい',
      '聞きたい',
      '確かめたい',
      '待てない',
    ])
  ) {
    return 'mid';
  }

  if (
    includesAny(text, [
      '少し様子を見る',
      '急がない',
      '落ち着いてから',
      '今は送らない',
    ])
  ) {
    return 'low';
  }

  return null;
}

export function buildRelationshipAnalysis(
  args: BuildRelationshipAnalysisArgs,
): RelationshipAnalysis {
  const merged = lowerLite(
    [
      args.userText,
      args.historyText,
      args.topicDigest,
      args.intentLabel,
    ]
      .filter(Boolean)
      .join(' '),
  );

  const emotionalTemperature = lowerLite(args.emotionalTemperature);

  return {
    attachment_hint: detectAttachmentHint(merged),
    projection_flag: detectProjectionFlag(merged),
    impulse_kind: detectImpulseKind(merged),
    self_value_shake: detectSelfValueShake(merged),
    pursuit_risk: detectPursuitRisk(merged, emotionalTemperature),
  };
}
