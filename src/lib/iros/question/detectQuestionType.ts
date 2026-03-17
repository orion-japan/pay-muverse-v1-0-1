// src/lib/iros/question/detectQuestionType.ts
// IROS QuestionEngine v1
// Phase2: question type detection (rule-based / safe-first)

import type { DetectQuestionTypeInput, DomainType, QuestionType } from './types';

type QuestionTypeScoreMap = Record<QuestionType, number>;

const INITIAL_SCORES = (): QuestionTypeScoreMap => ({
  truth: 0,
  structure: 0,
  cause: 0,
  choice: 0,
  meaning: 0,
  future_design: 0,
  unresolved_release: 0,
});

function normalizeText(input: string): string {
  return String(input ?? '').trim().toLowerCase();
}

function addIfMatched(
  scores: QuestionTypeScoreMap,
  text: string,
  qtype: QuestionType,
  patterns: RegExp[],
  weight = 1,
) {
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      scores[qtype] += weight;
    }
  }
}

function pickQuestionType(scores: QuestionTypeScoreMap): QuestionType {
  const entries = Object.entries(scores) as Array<[QuestionType, number]>;
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);

  const top = sorted[0];
  const second = sorted[1];

  // ✅ 未ヒット時は meaning に倒さない
  // - ここを meaning にすると、短い挨拶 / 入口文 / 雑談まで
  //   「意味解説ルート」に流れて explain_first が発火しやすくなる
  // - まずは既存型の中で explain_first 化しにくい structure を安全側 fallback にする
  if (!top || top[1] <= 0) return 'structure';

  // 完全拮抗は structure に寄せる
  if (second && second[1] > 0 && top[1] === second[1]) {
    return 'structure';
  }

  return top[0];
}

function applyDomainBias(
  scores: QuestionTypeScoreMap,
  domain: DomainType | null | undefined,
  text: string,
) {
  if (!domain) return;

  if (domain === 'cosmology') {
    if (/起源|介入|作った|作られた|仮説|地球外生命体|非人間知性/.test(text)) {
      scores.truth += 2;
      scores.structure += 1;
      scores.cause += 1;
    }
  }

  if (domain === 'practical') {
    if (/どうやる|どうすれば|進める|手順|実装|設計/.test(text)) {
      scores.future_design += 2;
      scores.choice += 1;
    }
  }

  if (domain === 'personal') {
    if (/意味|なんのため|どう受け取れば|なぜ自分は/.test(text)) {
      scores.meaning += 2;
    }
    if (/未完了|引っかかる|終わっていない|解消したい|手放したい/.test(text)) {
      scores.unresolved_release += 2;
    }
  }
}

export function detectQuestionType(input: DetectQuestionTypeInput): QuestionType {
  const userText = normalizeText(input.userText ?? '');
  const topicHint = normalizeText(String(input.context?.topicHint ?? ''));
  const situationSummary = normalizeText(String(input.context?.situationSummary ?? ''));
  const contextText = [topicHint, situationSummary].filter(Boolean).join('\n');

  if (!userText && !contextText) return 'structure';

  const applyTypeRules = (text: string, contextWeight = 1): QuestionTypeScoreMap => {
    const scores = INITIAL_SCORES();
    if (!text) return scores;

    const asksCapability =
      /何ができる|なにができる|できること|何をしてくれる|なにをしてくれる|どう役立つ|何がわかる|なにがわかる/.test(
        text,
      );

    const asksDirectDefinition =
      /とは|って何|どういう意味|何者|何のため|何をする/.test(text);

    const asksRepairAnswer =
      /答えて|ちゃんと答えて|一文で|そのまま答えて|はぐらかさず/.test(text);

    addIfMatched(
      scores,
      text,
      'truth',
      [
        /本当|事実|真実|正しい|誤り|本当に|ほんとうに/,
        /なのか|かどうか|ありえるか|存在するか/,
        /証拠|根拠|検証|実証/,
      ],
      2 * contextWeight,
    );

    addIfMatched(
      scores,
      text,
      'structure',
      [
        /構造|構造的|整理|分解|切り分け|並び|地図|枠組み/,
        /どう見える|どういう構造|どう捉える|俯瞰/,
      ],
      3 * contextWeight,
    );

    addIfMatched(
      scores,
      text,
      'cause',
      [
        /なぜ|どうして|原因|きっかけ|由来|理由/,
        /なぜ起きた|なぜそうなる|なぜそうなった/,
      ],
      2 * contextWeight,
    );

    addIfMatched(
      scores,
      text,
      'choice',
      [
        /どれ|どちら|選ぶ|選択|比較|違い|向いてる/,
        /aかbか|どっち|何を選べば/,
        /yes|no|断る|断りたい|断れない|流される|流された/,
        /押された|押し切られた|決めさせられ|決めさせられてる/,
        /その場の空気|場の空気|同調圧|空気圧|即答|保留/,
        /自分で決めた|自分の意思|主導権/,
        /勢いでyes|勢いで決めた|その場の勢い/,
        /つもりだけど|今思うと|あとから思うと/,
      ],
      2 * contextWeight,
    );

    addIfMatched(
      scores,
      text,
      'meaning',
      [
        /意味|意義|どう受け取る|どう捉える|何を意味する/,
        /自分にとって|どういう意味/,
      ],
      2 * contextWeight,
    );

    addIfMatched(
      scores,
      text,
      'future_design',
      [
        /これから|今後|未来|次に|進めたい|作りたい|設計したい/,
        /実装したい|形にしたい|どう進める|方針/,
      ],
      2 * contextWeight,
    );

    addIfMatched(
      scores,
      text,
      'unresolved_release',
      [
        /未完了|引っかかる|残っている|終わっていない|解消したい/,
        /手放したい|再配置したい|未消化/,
      ],
      3 * contextWeight,
    );

    if (/構造的に知りたい|構造で置き換える|構造として/.test(text)) {
      scores.structure += 4 * contextWeight;
    }

    if (/本当か|事実か|真実か|かどうか知りたい/.test(text)) {
      scores.truth += 3 * contextWeight;
    }

    if (/なぜ.*のか|どうして.*のか/.test(text)) {
      scores.cause += 3 * contextWeight;
    }

    // ✅ capability / definition / 再回答要求 は structure ではなく meaning 側へ寄せる
    // 目的:
    // - 「何ができるの？」を「主張の型」に倒さない
    // - 「Irosって何？」系を先に説明要求として扱う
    if (asksCapability) {
      scores.meaning += 5 * contextWeight;
      scores.structure = Math.max(0, scores.structure - 2 * contextWeight);
    }

    if (asksDirectDefinition) {
      scores.meaning += 3 * contextWeight;
    }

    if (asksCapability && asksRepairAnswer) {
      scores.meaning += 3 * contextWeight;
      scores.structure = Math.max(0, scores.structure - 3 * contextWeight);
    }
    const eTurn = normalizeText(String(input.eTurn ?? ''));
    const qCode = normalizeText(String(input.qCode ?? ''));
    const signalsObj =
      input.signals && typeof input.signals === 'object' ? input.signals : null;

    const topicHintText = normalizeText(String(input.context?.topicHint ?? ''));
    const situationSummaryText = normalizeText(String(input.context?.situationSummary ?? ''));

    const looksPersonalStateStatement =
      !!text &&
      input.domain === 'personal' &&
      !/[?？]/.test(text) &&
      /不安|こわい|怖い|つらい|苦しい|しんどい|寂しい|孤独|揺れる|迷う|モヤモヤ|落ち込む|苦手/.test(text);

    const hasRuntimeStateHints =
      !!eTurn ||
      !!qCode ||
      !!signalsObj ||
      !!topicHintText ||
      !!situationSummaryText;

    if (looksPersonalStateStatement && hasRuntimeStateHints) {
      scores.meaning += 2 * contextWeight;
      scores.structure = Math.max(0, scores.structure - 1 * contextWeight);
    }
    applyDomainBias(scores, input.domain, text);
    return scores;
  };

  const mergeScores = (base: QuestionTypeScoreMap, add: QuestionTypeScoreMap) => {
    (Object.keys(base) as Array<keyof QuestionTypeScoreMap>).forEach((k) => {
      base[k] += add[k];
    });
    return base;
  };

  // ✅ 主判定は userText
  const userScores = applyTypeRules(userText, 1);
  const finalScores = { ...userScores };

  // ✅ context は補助だけ
  if (!userText && contextText) {
    mergeScores(finalScores, applyTypeRules(contextText, 1));
  } else if (userText && contextText) {
    mergeScores(finalScores, applyTypeRules(contextText, 0.25));
  }

  return pickQuestionType(finalScores);
}
