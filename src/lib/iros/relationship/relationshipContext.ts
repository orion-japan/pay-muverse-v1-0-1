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
  RelationDomain,
  RelationRole,
  RelationStructure,
} from './relationshipTypes';

export type BuildRelationshipContextArgs = {
  userText: string;
  historyText?: string | null;
  topicDigest?: string | null;
  recalledMemory?: RelationshipMemory | null;
};

export type RelationshipContext = {
  relation_focus: RelationFocus | null;

  relation_domain?: RelationDomain | null;
  relation_role?: RelationRole | null;
  relation_structure?: RelationStructure | null;

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

function detectRelationDomain(text: string): RelationDomain {
  if (!text) return 'unknown';

  if (
    includesAny(text, [
      'クライアント',
      '顧客',
      'お客様',
      '案件',
      '仕事',
      '提案',
      '契約',
      '法人',
      '経営',
      '事業',
      '商談',
      '納品',
      '請求',
      '見積',
    ])
  ) {
    if (includesAny(text, ['クライアント', '顧客', 'お客様'])) return 'client';
    return 'business';
  }

  if (
    includesAny(text, [
      '共同研究',
      '共同',
      '協業',
      'チーム',
      'プロジェクト',
      '連携',
      'パートナー',
    ])
  ) {
    return 'collaboration';
  }

  if (
    includesAny(text, [
      '家族',
      '親戚',
      '親族',
      '父',
      '母',
      '親',
      '子ども',
      '子供',
      '兄',
      '弟',
      '姉',
      '妹',
      '夫',
      '妻',
      '旦那',
    ])
  ) {
    if (includesAny(text, ['親戚', '親族'])) return 'relative';
    return 'family';
  }

  if (includesAny(text, ['友達', '友人', '親友', '仲間'])) {
    return 'friendship';
  }

  if (includesAny(text, ['先生', '師匠', 'メンター', '講師'])) {
    return 'mentor';
  }

  if (
    includesAny(text, [
      '恋愛',
      '好き',
      '付き合',
      '彼氏',
      '彼女',
      '元彼',
      '元カレ',
      '元彼女',
      '元カノ',
      'デート',
      '復縁',
      '片思い',
      '告白',
      '会いたい',
      'line',
      'ライン',
      '既読',
      '未読',
    ])
  ) {
    return 'romance';
  }

  return 'neutral_person';
}

function detectRelationRole(text: string, domain: RelationDomain): RelationRole {
  if (!text) return 'unknown_person';

  if (includesAny(text, ['クライアント'])) return 'client';
  if (includesAny(text, ['顧客', 'お客様'])) return 'customer';
  if (includesAny(text, ['上司', '社長', '代表'])) return 'boss';
  if (includesAny(text, ['部下', 'スタッフ', '社員'])) return 'subordinate';
  if (includesAny(text, ['共同研究'])) return 'research_partner';
  if (includesAny(text, ['共同', '協業', '連携', 'パートナー'])) return 'collaborator';
  if (includesAny(text, ['父', '母', '親'])) return 'parent';
  if (includesAny(text, ['子ども', '子供'])) return 'child';
  if (includesAny(text, ['兄', '弟', '姉', '妹'])) return 'sibling';
  if (includesAny(text, ['夫', '妻', '旦那'])) return 'spouse';
  if (includesAny(text, ['親戚', '親族'])) return 'relative';
  if (includesAny(text, ['友達', '友人', '親友'])) return 'friend';
  if (includesAny(text, ['先生', '師匠', 'メンター', '講師'])) return 'mentor';

  if (domain === 'romance') return 'romantic_person';
  if (domain === 'client') return 'client';
  if (domain === 'customer') return 'customer';
  if (domain === 'business') return 'coworker';
  if (domain === 'collaboration') return 'collaborator';
  if (domain === 'family') return 'family';
  if (domain === 'relative') return 'relative';
  if (domain === 'friendship') return 'friend';

  return 'unknown_person';
}

function detectRelationStructure(text: string, domain: RelationDomain): RelationStructure {
  if (!text) return 'unknown';

  if (includesAny(text, ['責任範囲', '責任', '管理'])) {
    return 'responsibility_gap';
  }

  if (includesAny(text, ['進行', 'タイミング', '遅い', '時間がかかる', '段取り'])) {
    return 'progress_gap';
  }

  if (includesAny(text, ['役割', '立場', '担当', '範囲'])) {
    return 'role_gap';
  }

  if (includesAny(text, ['合意', '契約', '決定', 'すり合わせ', '明らか'])) {
    return 'agreement_gap';
  }

  if (includesAny(text, ['境界', '距離', '踏み込み', '線引き'])) {
    return 'boundary_gap';
  }

  if (includesAny(text, ['信頼', '信用', '疑い'])) {
    return 'trust_gap';
  }

  if (includesAny(text, ['伝わらない', '連絡', '返信', '言葉', '説明'])) {
    return 'communication_gap';
  }

  if (includesAny(text, ['期待', '温度差', 'ズレ', '違い'])) {
    return 'expectation_gap';
  }

  if (includesAny(text, ['相続', '家系', '親族', '親戚'])) {
    return 'inheritance_gap';
  }

  if (domain === 'romance') return 'emotional_bond';
  if (domain === 'business' || domain === 'client' || domain === 'customer') return 'agreement_gap';
  if (domain === 'collaboration') return 'role_gap';
  if (domain === 'family' || domain === 'relative') return 'care_gap';
  if (domain === 'community') return 'community_gap';

  return 'unknown';
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

  const relationDomain = detectRelationDomain(merged);
  const relationRole = detectRelationRole(merged, relationDomain);
  const relationStructure = detectRelationStructure(merged, relationDomain);

  return {
    relation_focus: detectRelationFocus(merged),

    relation_domain: relationDomain,
    relation_role: relationRole,
    relation_structure: relationStructure,

    distance_level: detectDistanceLevel(merged),
    certainty_level: detectCertaintyLevel(merged),
    power_balance: detectPowerBalance(merged),
    interaction_stage: detectInteractionStage(merged),
    last_interaction_kind: detectLastInteractionKind(merged),
  };
}
