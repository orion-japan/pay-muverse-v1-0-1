// src/lib/iros/question/detectDomain.ts
// IROS QuestionEngine v1
// Phase1: domain detection (rule-based / safe-first)

import type { DetectDomainInput, DomainType } from './types';

type DomainScoreMap = Record<Exclude<DomainType, 'mixed'>, number>;

const INITIAL_SCORES = (): DomainScoreMap => ({
  science: 0,
  philosophy: 0,
  personal: 0,
  practical: 0,
  creative: 0,
  cosmology: 0,
});

function normalizeText(input: string): string {
  return String(input ?? '').trim().toLowerCase();
}

function addIfMatched(
  scores: DomainScoreMap,
  text: string,
  domain: Exclude<DomainType, 'mixed'>,
  patterns: RegExp[],
  weight = 1,
) {
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      scores[domain] += weight;
    }
  }
}

function pickDomain(scores: DomainScoreMap): DomainType {
  const entries = Object.entries(scores) as Array<[Exclude<DomainType, 'mixed'>, number]>;
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);

  const top = sorted[0];
  const second = sorted[1];

  if (!top || top[1] <= 0) return 'mixed';

  // 上位が拮抗しているときは mixed
  if (second && second[1] > 0 && top[1] - second[1] <= 1) {
    return 'mixed';
  }

  return top[0];
}

export function detectDomain(input: DetectDomainInput): DomainType {
  const userText = normalizeText(input.userText ?? '');
  const topicHint = normalizeText(String(input.context?.topicHint ?? ''));
  const situationSummary = normalizeText(String(input.context?.situationSummary ?? ''));
  const contextText = [topicHint, situationSummary].filter(Boolean).join('\n');

  if (!userText && !contextText) return 'mixed';

  const applyDomainRules = (text: string, contextWeight = 1): DomainScoreMap => {
    const scores = INITIAL_SCORES();
    if (!text) return scores;

    // personal: 自分の状態・感情・内面
    addIfMatched(
      scores,
      text,
      'personal',
      [
        /わたし|私|自分|僕|俺/,
        /気持ち|感情|つらい|苦しい|悲しい|不安|怖い|しんどい|疲れた/,
        /やる気|迷い|本音|本当は|どうしたい|戻ってきた気がする/,
        /未完了|引っかかる|まだ残っている|終わっていない/,
      ],
      2 * contextWeight,
    );

    // practical
    addIfMatched(
      scores,
      text,
      'practical',
      [
        /実装|手順|修正|対応|確認|ログ|配線|検証|エラー|tsc|sql|コード|ファイル/,
        /どうやる|どうすれば|どこを直す|次にやる|進め方|作業/,
        /運用|設計書|仕様書|連携|統合/,
      ],
      2 * contextWeight,
    );

    // creative
    addIfMatched(
      scores,
      text,
      'creative',
      [
        /構想|企画|世界観|表現|作品|パンフ|資料|名前|ネーミング/,
        /つくりたい|作りたい|デザイン|演出|物語|シナリオ|コンセプト/,
        /アプリにしたい|形にしたい|構成/,
      ],
      2 * contextWeight,
    );

    // philosophy
    addIfMatched(
      scores,
      text,
      'philosophy',
      [
        /意味|本質|真実|構造|存在|意識|なぜ|どうして|とは何か/,
        /哲学|真理|認識|世界とは|人間とは|愛とは/,
        /構造的に知りたい|どういうこと/,
      ],
      2 * contextWeight,
    );

    // science
    addIfMatched(
      scores,
      text,
      'science',
      [
        /科学|物理|化学|生物|脳|遺伝子|進化|医学|実験|観測|データ|理論/,
        /根拠|証拠|事実|検証|実証|再現性/,
        /ai|llm|モデル|アルゴリズム|システム/,
      ],
      2 * contextWeight,
    );

    // cosmology
    addIfMatched(
      scores,
      text,
      'cosmology',
      [
        /宇宙|宇宙起源|宇宙文明|宇宙由来/,
        /地球外生命体|非人間知性|異星知性|高次知性/,
        /人類の起源|人間の起源|文明の起源|生命の起源|世界の始まり/,
        /外部介入|介入仮説|起源仮説|創造仮説|設計仮説/,
        /人間は.*作られた|人類は.*作られた|人間を.*作った|人類を.*作った/,
        /文明を.*与えた|知性を.*与えた|遺伝子を.*改変/,
      ],
      3 * contextWeight,
    );

    if (/人間の起源|人類の起源|宇宙の起源|文明の起源|生命の起源/.test(text)) {
      scores.cosmology += 3 * contextWeight;
      scores.philosophy += 1 * contextWeight;
    }

    if (/地球外生命体|非人間知性|異星知性/.test(text) && /構造|構造的|仮説|起源/.test(text)) {
      scores.cosmology += 4 * contextWeight;
    }

    if (/実装仕様書|設計書|手順書/.test(text)) {
      scores.practical += 3 * contextWeight;
    }

    if (/本当はどうしたい|どう感じてる|どう思ってる/.test(text)) {
      scores.personal += 2 * contextWeight;
    }

    return scores;
  };

  const mergeScores = (base: DomainScoreMap, add: DomainScoreMap) => {
    (Object.keys(base) as Array<keyof DomainScoreMap>).forEach((k) => {
      base[k] += add[k];
    });
    return base;
  };

  // ✅ 主判定は userText
  const userScores = applyDomainRules(userText, 1);

  // ✅ context は補助だけ
  // - userText が空のときだけそのまま使う
  // - userText があるときは 0.35 倍程度の弱い補助
  const finalScores = { ...userScores };
  if (!userText && contextText) {
    mergeScores(finalScores, applyDomainRules(contextText, 1));
  } else if (userText && contextText) {
    mergeScores(finalScores, applyDomainRules(contextText, 0.35));
  }

  return pickDomain(finalScores);
}
