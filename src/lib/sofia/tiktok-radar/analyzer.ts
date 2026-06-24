export type TikTokRadarAnalyzeInput = {
  category: string;
  keyword: string;
  hook_text: string;
  caption_text: string;
  top_comment: string;
};

export type TikTokRadarAnalyzeResult = {
  reaction_words: string;
  resonance_words: string;
  why_known_score: string;
  resonance_score: string;
  save_intent_score: string;
  sofia_note: string;
  status: string;
};

const reactionWordPatterns = [
  "なんでわかるの",
  "それ私",
  "私のこと",
  "当たりすぎ",
  "刺さる",
  "泣いた",
  "涙",
  "保存",
  "見返す",
  "今の私",
  "まさに",
  "わかりすぎる",
  "鳥肌",
  "言語化",
  "救われた",
  "しんどい",
  "苦しい",
];

const resonanceWordPatterns = [
  "連絡が来ない",
  "待っている",
  "追いかける",
  "不安",
  "自己否定",
  "責めている",
  "愛されたい",
  "執着",
  "手放せない",
  "離れられない",
  "相手の気持ち",
  "自分の価値",
  "苦しい",
  "寂しい",
  "我慢",
  "本音",
  "未読",
  "既読",
  "沈黙",
  "都合のいい人",
  "境界線",
  "承認欲求",
  "依存",
  "見捨てられ不安",
];

const saveIntentPatterns = [
  "保存",
  "見返す",
  "覚えて",
  "チェック",
  "まとめ",
  "特徴",
  "サイン",
  "理由",
  "共通点",
  "何度も",
];

const muLeadPatterns = [
  "なんで",
  "本当は",
  "実は",
  "見抜",
  "気づいて",
  "相手の気持ち",
  "自分の価値",
  "止まって",
  "言葉に",
];

function uniqueJoin(words: string[]) {
  return Array.from(new Set(words.filter(Boolean))).join(" / ");
}

function clampScore(score: number) {
  return String(Math.max(0, Math.min(5, score)));
}

function countMatches(text: string, patterns: string[]) {
  return patterns.filter((word) => text.includes(word)).length;
}

function hasAny(text: string, patterns: string[]) {
  return patterns.some((word) => text.includes(word));
}

export function analyzeTikTokRadarInput(
  input: TikTokRadarAnalyzeInput
): TikTokRadarAnalyzeResult {
  const text = [
    input.category,
    input.keyword,
    input.hook_text,
    input.caption_text,
    input.top_comment,
  ]
    .filter(Boolean)
    .join("\n");

  const reactionHits = reactionWordPatterns.filter((word) => text.includes(word));
  const resonanceHits = resonanceWordPatterns.filter((word) => text.includes(word));
  const saveHits = saveIntentPatterns.filter((word) => text.includes(word));

  const hasQuestionFeeling =
    text.includes("なぜ") ||
    text.includes("なんで") ||
    text.includes("本当は") ||
    text.includes("実は") ||
    text.includes("気づいて") ||
    text.includes("見抜");

  const hasLoveTheme =
    text.includes("恋愛") ||
    text.includes("復縁") ||
    text.includes("片思い") ||
    text.includes("連絡") ||
    text.includes("相手") ||
    text.includes("既読") ||
    text.includes("未読");

  const hasPainTheme =
    text.includes("苦しい") ||
    text.includes("不安") ||
    text.includes("寂しい") ||
    text.includes("責め") ||
    text.includes("我慢") ||
    text.includes("しんどい") ||
    text.includes("見捨てられ");

  const hasMuLeadTheme = hasAny(text, muLeadPatterns);
  const hasSaveFormat = hasAny(text, saveIntentPatterns);

  const reactionCount = countMatches(text, reactionWordPatterns);
  const resonanceCount = countMatches(text, resonanceWordPatterns);
  const saveCount = countMatches(text, saveIntentPatterns);

  const whyScore = clampScore(
    2 + reactionCount + (hasQuestionFeeling ? 1 : 0) + (hasPainTheme ? 1 : 0) + (hasMuLeadTheme ? 1 : 0)
  );

  const resonanceScore = clampScore(
    2 + resonanceCount + (hasLoveTheme ? 1 : 0) + (hasPainTheme ? 1 : 0)
  );

  const saveScore = clampScore(
    1 + saveCount + (hasSaveFormat ? 1 : 0) + (hasPainTheme ? 1 : 0) + (hasQuestionFeeling ? 1 : 0)
  );

  const reactionWords = uniqueJoin(
    reactionHits.length > 0
      ? reactionHits
      : ["それ私", "なんでわかるの", "刺さる"]
  );

  const resonanceWords = uniqueJoin(
    resonanceHits.length > 0
      ? resonanceHits
      : [
          input.keyword,
          hasLoveTheme ? "相手の気持ち" : "",
          hasPainTheme ? "苦しい" : "",
          hasQuestionFeeling ? "本当は" : "",
        ]
  );

  const totalScore = Number(whyScore) + Number(resonanceScore) + Number(saveScore);
  const status =
    totalScore >= 13 || Number(whyScore) >= 5 || Number(resonanceScore) >= 5
      ? "winner"
      : totalScore >= 10 || Number(whyScore) >= 4 || Number(resonanceScore) >= 4
        ? "good"
        : totalScore >= 7
          ? "watch"
          : "draft";

  const sofiaNote = [
    "Sofia自動分析:",
    hasLoveTheme
      ? "恋愛・関係性の入口として使いやすいテーマです。"
      : "内面理解の入口として確認できます。",
    hasQuestionFeeling
      ? "冒頭に“見抜かれた感覚”があり、「なんでわかるの？」につながる可能性があります。"
      : "冒頭にもう少し“見抜き”の言葉を足すと強くなります。",
    hasPainTheme
      ? "不安・苦しさ・自己否定に触れているため、共鳴が起きやすいです。"
      : "痛みの言語が少ないため、共鳴語を追加すると伸びやすいです。",
    hasSaveFormat
      ? "保存・見返しに向く構造があります。保存型投稿に展開できます。"
      : "保存型にするなら、チェックリスト・特徴・理由の形に整えると強くなります。",
    hasMuLeadTheme
      ? "Mu導線に接続しやすい言葉があります。最後は“相手を当てる”ではなく“自分の止まりを映す”方向にしてください。"
      : "Mu導線へつなぐには、内側の止まり・見落とし・言葉になっていないズレを足してください。",
    `反応語候補: ${reactionWords}`,
    `共鳴語候補: ${resonanceWords}`,
    `保存語候補: ${uniqueJoin(saveHits.length > 0 ? saveHits : ["保存", "見返す", "チェック"])}`,
  ].join("\n");

  return {
    reaction_words: reactionWords,
    resonance_words: resonanceWords,
    why_known_score: whyScore,
    resonance_score: resonanceScore,
    save_intent_score: saveScore,
    sofia_note: sofiaNote,
    status,
  };
}
