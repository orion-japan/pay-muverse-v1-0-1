// src/lib/iros/relationship/relationshipContext.ts
// iros — Relationship Layer v1.0 (context)
// 会話テキストから関係の現在地を軽く推定する

import type {
  CertaintyLevel,
  DistanceLevel,
  InteractionStage,
  PowerBalance,
  RelationFocus,
  RelationshipMemory,
} from './relationshipTypes';

export type BuildRelationshipContextArgs = {
  userText: string;
  historyText?: string | null;
  topicDigest?: string | null;
  recalledMemory?: RelationshipMemory | null;
};

export type RelationshipContext = {
  relation_focus: RelationFocus | null;
  distance_level: DistanceLevel | null;
  certainty_level: CertaintyLevel | null;
  power_balance: PowerBalance | null;
  interaction_stage: InteractionStage | null;
  last_interaction_kind: string | null;
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

function detectDistanceLevel(text: string): DistanceLevel | null {
  if (!text) return null;

  if (
    includesAny(text, [
      '毎日',
      'よく話す',
      'ずっと連絡',
      '頻繁',
      '近い',
      '仲良い',
      '会えてる',
    ])
  ) {
    return 'low';
  }

  if (
    includesAny(text, [
      '返信がない',
      '返信こない',
      '既読無視',
      '未読',
      '距離',
      '離れ',
      '会えてない',
      '止まってる',
    ])
  ) {
    return 'high';
  }

  if (
    includesAny(text, [
      'たまに',
      'ときどき',
      '少し',
      'まだ',
      '様子見',
    ])
  ) {
    return 'mid';
  }

  return null;
}

function detectCertaintyLevel(text: string): CertaintyLevel | null {
  if (!text) return null;

  if (
    includesAny(text, [
      'わからない',
      '不明',
      '読めない',
      '曖昧',
      'はっきりしない',
      '自信がない',
    ])
  ) {
    return 'low';
  }

  if (
    includesAny(text, [
      'たぶん',
      'おそらく',
      'かもしれない',
      '気がする',
      '微妙',
    ])
  ) {
    return 'mid';
  }

  if (
    includesAny(text, [
      '確実',
      'はっきり',
      '決まってる',
      '明確',
      '間違いない',
    ])
  ) {
    return 'high';
  }

  return null;
}

function detectPowerBalance(text: string): PowerBalance | null {
  if (!text) return null;

  if (
    includesAny(text, [
      '振り回され',
      '相手次第',
      '待つしかない',
      '相手のペース',
      '向こうが決める',
    ])
  ) {
    return 'other_dominant';
  }

  if (
    includesAny(text, [
      '自分から決めた',
      '自分が主導',
      'こちらから動いた',
      '自分のペース',
    ])
  ) {
    return 'user_dominant';
  }

  if (
    includesAny(text, [
      'お互い',
      '対等',
      '自然',
      'バランス',
    ])
  ) {
    return 'balanced';
  }

  return null;
}

function detectInteractionStage(text: string): InteractionStage | null {
  if (!text) return null;

  if (
    includesAny(text, [
      '出会った',
      '知り合った',
      '初めて',
      '最初',
    ])
  ) {
    return 'initial';
  }

  if (
    includesAny(text, [
      'やりとりしてる',
      '連絡してる',
      '少しずつ',
      '仲良くなってきた',
    ])
  ) {
    return 'building';
  }

  if (
    includesAny(text, [
      '深く',
      'ちゃんと付き合',
      '将来',
      '大事な話',
    ])
  ) {
    return 'deepening';
  }

  if (
    includesAny(text, [
      '不安定',
      '揺れてる',
      '返信が止ま',
      '会う話で止ま',
      'ぎくしゃく',
    ])
  ) {
    return 'unstable';
  }

  if (
    includesAny(text, [
      '距離を置',
      '離れたい',
      '終わり',
      '別れ',
      '切れた',
    ])
  ) {
    return 'detaching';
  }

  return null;
}

function detectRelationFocus(text: string): RelationFocus | null {
  if (!text) return null;

  if (
    includesAny(text, [
      '近づきたい',
      '仲良くなりたい',
      '進めたい',
      '関係を深めたい',
    ])
  ) {
    return 'approaching';
  }

  if (
    includesAny(text, [
      '安定',
      '落ち着いてる',
      '順調',
      '普通に続いてる',
    ])
  ) {
    return 'stable';
  }

  if (
    includesAny(text, [
      '距離がある',
      '離れてる',
      '冷たくなった',
      '返信がない',
      '止まってる',
    ])
  ) {
    return 'distancing';
  }

  if (
    includesAny(text, [
      'わからない',
      'どう思ってるかわからない',
      '曖昧',
      '読めない',
    ])
  ) {
    return 'uncertain';
  }

  if (
    includesAny(text, [
      '終わった',
      '別れた',
      '壊れた',
      'もう無理',
    ])
  ) {
    return 'broken';
  }

  return null;
}

function detectLastInteractionKind(text: string): string | null {
  if (!text) return null;

  if (includesAny(text, ['返信', '既読', '未読', 'line', 'dm', 'メッセージ'])) {
    return 'message';
  }

  if (includesAny(text, ['会う', '会った', 'デート', '会える'])) {
    return 'meeting';
  }

  if (includesAny(text, ['電話', '通話'])) {
    return 'call';
  }

  if (includesAny(text, ['けんか', '喧嘩', 'ぶつかった'])) {
    return 'conflict';
  }

  return null;
}

export function buildRelationshipContext(
  args: BuildRelationshipContextArgs,
): RelationshipContext {
  const userText = normalizeLite(args.userText);
  const historyText = normalizeLite(args.historyText);
  const topicDigest = normalizeLite(args.topicDigest);

  const memoryFacts = Array.isArray(args.recalledMemory?.facts)
    ? args.recalledMemory!.facts.join(' ')
    : '';

  const memoryPatterns = Array.isArray(args.recalledMemory?.patterns)
    ? args.recalledMemory!.patterns.join(' ')
    : '';

  const merged = lowerLite(
    [userText, historyText, topicDigest, memoryFacts, memoryPatterns]
      .filter(Boolean)
      .join(' '),
  );

  return {
    relation_focus: detectRelationFocus(merged),
    distance_level: detectDistanceLevel(merged),
    certainty_level: detectCertaintyLevel(merged),
    power_balance: detectPowerBalance(merged),
    interaction_stage: detectInteractionStage(merged),
    last_interaction_kind: detectLastInteractionKind(merged),
  };
}
