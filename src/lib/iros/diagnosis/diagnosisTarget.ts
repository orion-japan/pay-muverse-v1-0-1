import { normalizeDiagnosisTargetKey } from '@/lib/iros/memory/normalizeDiagnosisTargetKey';

export type DiagnosisTargetType =
  | 'self'
  | 'person'
  | 'topic'
  | 'relationship'
  | 'person_topic'
  | 'unknown';

export type NormalizedDiagnosisTarget = {
  rawLabel: string;
  targetLabel: string;
  targetType: DiagnosisTargetType;

  // 既存互換用。今の実装では self / other / situation を使っているため残す。
  targetScope: 'self' | 'other' | 'situation';

  // 既存DB互換用。target_key に近い通常検索キー。
  targetKey: string | null;

  // 将来の Flow Pattern Memory 用。関係・人と事を混ぜないための構造キー。
  structuredTargetKey: string | null;

  targetPersons: string[];
  targetTopic: string | null;

  confidence: number;
  reason: string;
};

const SELF_TARGET_RE =
  /^(自分|今の自分|自分自身|本当の自分|わたし|私|僕|俺|ぼく|自分のこと)$/u;

const HONORIFIC_SUFFIX_RE = /(さん|様|先生|くん|君|ちゃん|氏)$/u;

const RELATION_SUFFIX_RE =
  /(との関係性|との関係|との相性|とのつながり|との繋がり|の関係性|の関係|関係性|関係|相性)$/u;

const TOPIC_WORD_RE =
  /(仕事|計画|企画|事業|申請|助成金|映像|動画|投稿|サービス|アプリ|実装|開発|設計|資料|文章|プロンプト|プロジェクト|契約|会議|打ち合わせ|イベント|マッピング|花火|ランタン|本|書籍|講座|商品|サイト|LP|SNS|TikTok|集客|売上|お金|予定|問題|課題|状況|状態|流れ|方向性|方針|企画書|関係|関係性|連絡|返信|返事)/u;

function cleanTargetLabel(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[「」『』]/g, '')
    .replace(/^[\s　:：\-]+/u, '')
    .replace(/[\s　:：\-]+$/u, '')
    .replace(/^(ir診断|IR診断|診断|ir|IR)\s*/iu, '')
    .replace(/^(してください|して|お願いします|お願い|下さい|ください)/u, '')
    .replace(/(してください|して|お願いします|お願い|下さい|ください)$/u, '')
    .replace(/(を|について|に関して|のこと)$/u, '')
    .trim();
}

function cleanName(value: unknown): string {
  return cleanTargetLabel(value)
    .replace(HONORIFIC_SUFFIX_RE, '')
    .trim();
}

function keyOf(value: unknown): string | null {
  return normalizeDiagnosisTargetKey(value);
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const cleaned = cleanName(value);
    if (!cleaned) continue;

    const key = keyOf(cleaned) ?? cleaned;
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(cleaned);
  }

  return out;
}

function sortKeysForRelationship(persons: string[]): string[] {
  return persons
    .map((person) => keyOf(person) ?? cleanName(person))
    .filter((x) => x.length > 0)
    .sort((a, b) => a.localeCompare(b, 'ja'));
}

function stripRelationSuffix(value: string): string {
  return cleanTargetLabel(value).replace(RELATION_SUFFIX_RE, '').trim();
}

function splitRelationParts(value: string): string[] {
  const base = stripRelationSuffix(value);

  if (!base) return [];

  if (base.includes('と')) {
    return base
      .split('と')
      .map((x) => cleanName(x))
      .filter(Boolean);
  }

  const spaceParts = base
    .split(/[\s　]+/u)
    .map((x) => cleanName(x))
    .filter(Boolean);

  if (spaceParts.length >= 2) return spaceParts;

  return [cleanName(base)].filter(Boolean);
}

function looksTopic(value: string): boolean {
  return TOPIC_WORD_RE.test(value);
}

export function normalizeDiagnosisTarget(value: unknown): NormalizedDiagnosisTarget {
  const rawLabel = cleanTargetLabel(value);
  const fallbackLabel = rawLabel || '自分';

  if (SELF_TARGET_RE.test(fallbackLabel)) {
    return {
      rawLabel: fallbackLabel,
      targetLabel: '自分',
      targetType: 'self',
      targetScope: 'self',
      targetKey: '自分',
      structuredTargetKey: 'self',
      targetPersons: [],
      targetTopic: null,
      confidence: 1,
      reason: 'self_target',
    };
  }

  const hasRelationPhrase = RELATION_SUFFIX_RE.test(fallbackLabel);

  if (hasRelationPhrase) {
    const parts = splitRelationParts(fallbackLabel);

    if (parts.length >= 2) {
      const first = parts[0];
      const second = parts.slice(1).join('と');

      if (looksTopic(second)) {
        const person = cleanName(first);
        const topic = cleanTargetLabel(second);
        const personKey = keyOf(person);
        const topicKey = keyOf(topic);

        return {
          rawLabel: fallbackLabel,
          targetLabel: `${person}と${topic}の関係`,
          targetType: 'person_topic',
          targetScope: 'situation',
          targetKey: keyOf(`${person}と${topic}の関係`),
          structuredTargetKey:
            personKey && topicKey ? `person_topic:${personKey}__${topicKey}` : null,
          targetPersons: person ? [person] : [],
          targetTopic: topic || null,
          confidence: 0.92,
          reason: 'relation_phrase_person_topic',
        };
      }

      const persons = uniqueNonEmpty(parts);
      const sortedKeys = sortKeysForRelationship(persons);

      return {
        rawLabel: fallbackLabel,
        targetLabel:
          persons.length >= 2
            ? `${persons[0]}と${persons[1]}の関係`
            : `${persons[0] ?? fallbackLabel}との関係`,
        targetType: 'relationship',
        targetScope: 'situation',
        targetKey: keyOf(`${persons.join('と')}の関係`),
        structuredTargetKey:
          sortedKeys.length > 0 ? `relationship:${sortedKeys.join('__')}` : null,
        targetPersons: persons,
        targetTopic: null,
        confidence: persons.length >= 2 ? 0.94 : 0.72,
        reason: 'relation_phrase_person_person',
      };
    }

    const single = cleanName(parts[0] ?? stripRelationSuffix(fallbackLabel));

    return {
      rawLabel: fallbackLabel,
      targetLabel: single ? `${single}との関係` : fallbackLabel,
      targetType: 'relationship',
      targetScope: 'situation',
      targetKey: keyOf(single ? `${single}との関係` : fallbackLabel),
      structuredTargetKey: single ? `relationship:${keyOf(single) ?? single}` : null,
      targetPersons: single ? [single] : [],
      targetTopic: null,
      confidence: 0.7,
      reason: 'relation_phrase_single_target',
    };
  }

  if (looksTopic(fallbackLabel)) {
    const topic = cleanTargetLabel(fallbackLabel);
    const topicKey = keyOf(topic);

    return {
      rawLabel: fallbackLabel,
      targetLabel: topic,
      targetType: 'topic',
      targetScope: 'situation',
      targetKey: topicKey,
      structuredTargetKey: topicKey ? `topic:${topicKey}` : null,
      targetPersons: [],
      targetTopic: topic,
      confidence: 0.86,
      reason: 'topic_word_match',
    };
  }

  const person = cleanName(fallbackLabel);
  const personKey = keyOf(person);

  return {
    rawLabel: fallbackLabel,
    targetLabel: person || fallbackLabel,
    targetType: person ? 'person' : 'unknown',
    targetScope: person ? 'other' : 'situation',
    targetKey: personKey,
    structuredTargetKey: personKey ? `person:${personKey}` : null,
    targetPersons: person ? [person] : [],
    targetTopic: null,
    confidence: person ? 0.78 : 0.3,
    reason: person ? 'default_person_target' : 'unknown_target',
  };
}
