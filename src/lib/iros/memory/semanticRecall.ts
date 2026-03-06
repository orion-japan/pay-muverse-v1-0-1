// src/lib/iros/memory/semanticRecall.ts
// iros — Semantic Recall v1
//
// 目的:
// - 現在の userText / conversationLine / topicDigest と
//   過去 snapshot の意味的な近さを、軽量ルールベースで判定する
// - embedding なしの擬似 semantic recall
//
// 方針:
// - 完全一致
// - 同義語グループ一致
// - topic / summary の近接
// - 補助点（situationTopic / depthStage）
// を合算して score 化する

export type SemanticSnapshotLike = {
  id?: string | null;
  summary?: string | null;
  topic?: string | null;
  situation_summary?: string | null;
  situation_topic?: string | null;
  depth_stage?: string | null;
  phase?: string | null;
  q_code?: string | null;
  [key: string]: any;
};

export type ScoreSemanticRecallArgs = {
  userText?: string | null;
  conversationLine?: string | null;
  topicDigest?: string | null;
  situationTopic?: string | null;
  depthStage?: string | null;
  snapshot: SemanticSnapshotLike;
};

export type ScoreSemanticRecallResult = {
  score: number;
  matchedTerms: string[];
  reason: string[];
};

export type FindSemanticSnapshotsArgs = {
  userText?: string | null;
  conversationLine?: string | null;
  topicDigest?: string | null;
  situationTopic?: string | null;
  depthStage?: string | null;
  snapshots: SemanticSnapshotLike[];
  minScore?: number;
  topN?: number;
};

export type FindSemanticSnapshotsResult = {
  hits: SemanticSnapshotLike[];
  bestScore: number;
  matchedTerms: string[];
};

const SYNONYM_GROUPS: Array<{ key: string; terms: string[] }> = [
  { key: '巻き戻り', terms: ['巻き戻り', '戻る', '戻ってる', '逆行', '後退', '再浮上', '前の感じ', '前に戻る'] },
  { key: '再確認', terms: ['再確認', '確認し直す', '見直す', 'もう一度', 'なんだっけ', '思い出す', '確かめる'] },
  { key: '整理', terms: ['整理', '整える', '整え直す', '片づける', 'まとめる', '順番', '落ち着ける'] },
  { key: '仕事', terms: ['仕事', '職場', '会社', '転職', '働く', '業務', 'キャリア', '上司', '評価'] },
  { key: '人間関係', terms: ['人間関係', '関係', '相手', '恋愛', '夫婦', '家族', '友達', '距離感', 'つながり'] },
  { key: '不安', terms: ['不安', 'こわい', '怖い', '心配', '迷い', '焦り', '落ち着かない', '重い'] },
  { key: '停滞', terms: ['停滞', '止まる', '進めない', '動けない', 'やる気が出ない', '詰まる', '固まる'] },
  { key: '前進', terms: ['前進', '進みたい', '続けたい', '動きたい', '始めたい', 'やってみる', '切り替える'] },
  { key: '体調', terms: ['体調', 'しんどい', '疲れ', '眠い', '眠れない', 'だるい', '気力', '元気'] },
  { key: '感情', terms: ['感情', '気持ち', 'モヤモヤ', '苦しい', 'つらい', '悲しい', '怒り', 'イライラ'] },
  { key: '過去テーマ', terms: ['前回', '前に', '過去', '昔', '以前', 'この前', '記憶', '思い出'] },
];

function normalizeText(input: string | null | undefined): string {
  if (!input) return '';
  return String(input)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/[“”"'`’]/g, '')
    .trim()
    .toLowerCase();
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function collectCurrentText(args: Omit<ScoreSemanticRecallArgs, 'snapshot'>): string {
  return [
    normalizeText(args.userText),
    normalizeText(args.conversationLine),
    normalizeText(args.topicDigest),
    normalizeText(args.situationTopic),
  ]
    .filter(Boolean)
    .join('\n');
}

function collectSnapshotText(snapshot: SemanticSnapshotLike): string {
  return [
    normalizeText(snapshot.summary),
    normalizeText(snapshot.topic),
    normalizeText(snapshot.situation_summary),
    normalizeText(snapshot.situation_topic),
  ]
    .filter(Boolean)
    .join('\n');
}

function includesAny(text: string, terms: string[]): string[] {
  const hits: string[] = [];
  for (const t of terms) {
    const n = normalizeText(t);
    if (!n) continue;
    if (text.includes(n)) hits.push(t);
  }
  return hits;
}

function overlapKeywords(a: string, b: string): string[] {
  const out: string[] = [];
  for (const row of SYNONYM_GROUPS) {
    const aHits = includesAny(a, row.terms);
    const bHits = includesAny(b, row.terms);
    if (aHits.length > 0 && bHits.length > 0) {
      out.push(row.key);
    }
  }
  return uniq(out);
}

export function scoreSemanticRecallV1(
  args: ScoreSemanticRecallArgs,
): ScoreSemanticRecallResult {
  const currentText = collectCurrentText(args);
  const snapshotText = collectSnapshotText(args.snapshot);

  if (!currentText || !snapshotText) {
    return {
      score: 0,
      matchedTerms: [],
      reason: ['EMPTY_TEXT'],
    };
  }

  let score = 0;
  const matchedTerms: string[] = [];
  const reason: string[] = [];

  // A. 完全一致 / 強一致
  const currentLine = normalizeText(args.conversationLine);
  const currentDigest = normalizeText(args.topicDigest);
  const snapSummary = normalizeText(args.snapshot.summary);
  const snapTopic = normalizeText(args.snapshot.topic);

  if (currentLine && snapSummary && currentLine === snapSummary) {
    score += 3;
    matchedTerms.push(currentLine);
    reason.push('LINE_EQ_SUMMARY');
  }

  if (currentLine && snapTopic && currentLine === snapTopic) {
    score += 3;
    matchedTerms.push(currentLine);
    reason.push('LINE_EQ_TOPIC');
  }

  if (currentDigest && snapSummary && currentDigest === snapSummary) {
    score += 3;
    matchedTerms.push(currentDigest);
    reason.push('DIGEST_EQ_SUMMARY');
  }

  if (currentDigest && snapTopic && currentDigest === snapTopic) {
    score += 3;
    matchedTerms.push(currentDigest);
    reason.push('DIGEST_EQ_TOPIC');
  }

  // B. 同義語グループ一致
  const synonymMatches = overlapKeywords(currentText, snapshotText);
  if (synonymMatches.length > 0) {
    score += synonymMatches.length * 2;
    matchedTerms.push(...synonymMatches);
    reason.push(`SYNONYM_MATCH:${synonymMatches.join(',')}`);
  }

  // C. 要約近接（conversationLine / topicDigest が snapshot text に含まれる）
  if (currentLine && snapshotText.includes(currentLine) && !matchedTerms.includes(currentLine)) {
    score += 2;
    matchedTerms.push(currentLine);
    reason.push('LINE_INCLUDED');
  }

  if (currentDigest && snapshotText.includes(currentDigest) && !matchedTerms.includes(currentDigest)) {
    score += 2;
    matchedTerms.push(currentDigest);
    reason.push('DIGEST_INCLUDED');
  }

  // D. situationTopic 補助
  const currentSituationTopic = normalizeText(args.situationTopic);
  const snapshotSituationTopic = normalizeText(args.snapshot.situation_topic);
  if (
    currentSituationTopic &&
    snapshotSituationTopic &&
    currentSituationTopic === snapshotSituationTopic
  ) {
    score += 1;
    matchedTerms.push(`topic:${currentSituationTopic}`);
    reason.push('SITUATION_TOPIC_EQ');
  }

  // E. depthStage 補助
  const currentDepth = normalizeText(args.depthStage);
  const snapshotDepth = normalizeText(args.snapshot.depth_stage);
  if (currentDepth && snapshotDepth && currentDepth === snapshotDepth) {
    score += 1;
    matchedTerms.push(`depth:${currentDepth}`);
    reason.push('DEPTH_EQ');
  }

  return {
    score,
    matchedTerms: uniq(matchedTerms),
    reason: uniq(reason),
  };
}

export function findSemanticSnapshotsV1(
  args: FindSemanticSnapshotsArgs,
): FindSemanticSnapshotsResult {
  const minScore = Math.max(1, Number(args.minScore ?? 4) || 4);
  const topN = Math.max(1, Number(args.topN ?? 3) || 3);

  const ranked = (args.snapshots ?? [])
    .map((snapshot) => {
      const scored = scoreSemanticRecallV1({
        userText: args.userText,
        conversationLine: args.conversationLine,
        topicDigest: args.topicDigest,
        situationTopic: args.situationTopic,
        depthStage: args.depthStage,
        snapshot,
      });

      const contentMatchedTerms = scored.matchedTerms.filter(
        (term) => term && !term.startsWith('topic:') && !term.startsWith('depth:'),
      );

      return {
        snapshot,
        score: scored.score,
        matchedTerms: scored.matchedTerms,
        contentMatchedTerms,
        reason: scored.reason,
      };
    })
    .filter((row) => {
      // semantic は「内容語」が1つ以上ある場合のみ採用する
      // topic/depth だけの一致では新規話題に誤反応しやすいので除外
      return row.score >= minScore && row.contentMatchedTerms.length > 0;
    })
    .sort((a, b) => b.score - a.score);

  const hits = ranked.slice(0, topN);
  const best = hits[0];

  return {
    hits: hits.map((v) => v.snapshot),
    bestScore: best?.score ?? 0,
    matchedTerms: uniq(hits.flatMap((v) => v.matchedTerms)).slice(0, 8),
  };
}
