export type TikTokRadarPostIdeaInput = {
  category: string | null;
  keyword: string | null;
  hook_text: string | null;
  caption_text: string | null;
  top_comment: string | null;
  reaction_words: string | null;
  resonance_words: string | null;
  why_known_score: number | null;
  resonance_score: number | null;
  save_intent_score: number | null;
  sofia_note: string | null;
};

export type TikTokRadarPostIdea = {
  opening: string;
  body: string;
  muLead: string;
  hashtags: string;
  totalScore: number;
  scoreLabel: string;
};

function cleanText(value: string | null | undefined) {
  return (value ?? "").trim();
}

function scoreNumber(value: number | null | undefined) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function pickTheme(input: TikTokRadarPostIdeaInput) {
  const text = [
    input.category,
    input.keyword,
    input.hook_text,
    input.caption_text,
    input.top_comment,
    input.reaction_words,
    input.resonance_words,
  ]
    .filter(Boolean)
    .join(" ");

  if (text.includes("復縁") || text.includes("連絡")) {
    return {
      theme: "復縁・連絡待ち",
      pain: "相手の沈黙を見つめ続けるほど、自分の価値まで止まってしまうこと",
      shift: "見る場所を、相手の気持ちから自分の待ち方へ戻すこと",
      tag: "#復縁",
    };
  }

  if (text.includes("片思い")) {
    return {
      theme: "片思い",
      pain: "相手の反応ひとつで、自分の心が大きく揺れてしまうこと",
      shift: "相手に合わせる前に、自分の本音を見失わないこと",
      tag: "#片思い",
    };
  }

  if (text.includes("自己受容") || text.includes("自己否定")) {
    return {
      theme: "自己受容",
      pain: "変わりたいのに、自分を責めるほど動けなくなること",
      shift: "直す前に、なぜ責めてしまうのかを見ること",
      tag: "#自己受容",
    };
  }

  if (text.includes("成功") || text.includes("仕事")) {
    return {
      theme: "成功論",
      pain: "進みたいのに、内側で止めている感覚があること",
      shift: "努力量ではなく、意図の向きを整えること",
      tag: "#成功論",
    };
  }

  return {
    theme: cleanText(input.category) || "内面理解",
    pain: "自分でも言葉にできない違和感が残っていること",
    shift: "その違和感を、分かる言葉に変えること",
    tag: "#心の整理",
  };
}

export function buildTikTokRadarPostIdea(
  input: TikTokRadarPostIdeaInput
): TikTokRadarPostIdea {
  const hook = cleanText(input.hook_text);
  const keyword = cleanText(input.keyword);
  const resonanceWords = cleanText(input.resonance_words);
  const reactionWords = cleanText(input.reaction_words);

  const totalScore =
    scoreNumber(input.why_known_score) +
    scoreNumber(input.resonance_score) +
    scoreNumber(input.save_intent_score);

  const scoreLabel =
    totalScore >= 13
      ? "投稿候補として強い"
      : totalScore >= 10
        ? "投稿候補として使える"
        : totalScore >= 7
          ? "調整すれば使える"
          : "素材として保留";

  const theme = pickTheme(input);

  const opening =
    hook ||
    `${keyword || theme.theme}で苦しいとき、見ている場所が少しずれていることがあります。`;

  const body = [
    opening,
    "",
    `本当に苦しいのは、${theme.pain}です。`,
    "",
    `だから必要なのは、無理に答えを出すことではなく、${theme.shift}です。`,
    resonanceWords ? `\nこの投稿で使う共鳴語: ${resonanceWords}` : "",
    reactionWords ? `\n反応が出そうな言葉: ${reactionWords}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const muLead = [
    "その苦しさがどこから来ているのか、Muが映します。",
    "相手の答えを当てるためではなく、あなたの中で止まっている場所を見つけるためです。",
  ].join("\n");

  const hashtags = uniqueJoin([
    theme.tag,
    keyword ? `#${keyword.replace(/\s+/g, "")}` : "",
    "#恋愛心理",
    "#自己受容",
    "#Mu",
    "#なんでわかるの",
  ]);

  return {
    opening,
    body,
    muLead,
    hashtags,
    totalScore,
    scoreLabel,
  };
}

function uniqueJoin(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).join(" ");
}