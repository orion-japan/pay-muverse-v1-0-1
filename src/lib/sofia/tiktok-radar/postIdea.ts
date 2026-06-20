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

export type TikTokRadarPostIdeaVariant = {
  title: string;
  description: string;
  opening: string;
  body: string;
  muLead: string;
  hashtags: string;
};

export type TikTokRadarPostIdea = {
  opening: string;
  body: string;
  muLead: string;
  hashtags: string;
  totalScore: number;
  scoreLabel: string;
  muLeadScore: number;
  viralFormatScore: number;
  recommendedAction: string;
  sofiaStrategyNote: string;
  variants: TikTokRadarPostIdeaVariant[];
};

function cleanText(value: string | null | undefined) {
  return (value ?? "").trim();
}

function scoreNumber(value: number | null | undefined) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function uniqueJoin(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).join(" ");
}

function buildSearchText(input: TikTokRadarPostIdeaInput) {
  return [
    input.category,
    input.keyword,
    input.hook_text,
    input.caption_text,
    input.top_comment,
    input.reaction_words,
    input.resonance_words,
    input.sofia_note,
  ]
    .filter(Boolean)
    .join(" ");
}

function pickTheme(input: TikTokRadarPostIdeaInput) {
  const text = buildSearchText(input);

  if (text.includes("復縁") || text.includes("連絡")) {
    return {
      name: "復縁・連絡待ち",
      tag: "#復縁",
      pain: "連絡が来ない時間が、自分の価値まで止めてしまうこと",
      shift: "相手の沈黙ではなく、自分の待ち方を見ること",
      direct: "相手を待っているようで、本当は自分の価値が戻るのを待っています。",
    };
  }

  if (text.includes("片思い")) {
    return {
      name: "片思い",
      tag: "#片思い",
      pain: "相手の反応ひとつで、自分の気持ちまで揺れてしまうこと",
      shift: "相手の答えより先に、自分の気持ちの置き場を見ること",
      direct: "相手の反応を見ているようで、本当は自分が傷つかない場所を探しています。",
    };
  }

  if (text.includes("自己受容") || text.includes("自己否定")) {
    return {
      name: "自己受容",
      tag: "#自己受容",
      pain: "自分を責める声が強くなり、本来の感覚が見えにくくなること",
      shift: "変わろうとする前に、責めている場所を見つけること",
      direct: "変われないのではなく、責めている場所がまだ見えていないだけです。",
    };
  }

  if (text.includes("成功") || text.includes("仕事")) {
    return {
      name: "成功論",
      tag: "#成功論",
      pain: "動いているのに、なぜか流れが噛み合わないこと",
      shift: "努力量ではなく、意図の向きを見ること",
      direct: "足りないのは努力ではなく、向かっている先のズレかもしれません。",
    };
  }

  return {
    name: "内面理解",
    tag: "#内面理解",
    pain: "自分でもうまく説明できない苦しさが残っていること",
    shift: "感情を片づける前に、どこで止まっているかを見ること",
    direct: "答えがないのではなく、まだ見ていない場所に言葉が残っています。",
  };
}

function fallbackOpening(theme: ReturnType<typeof pickTheme>) {
  return `${theme.name}で苦しいとき、本当に見ているのは相手ではないかもしれません。`;
}

function buildBaseHashtags(themeTag: string, keyword: string) {
  return uniqueJoin([
    keyword ? `#${keyword.replace(/\s+/g, "")}` : "",
    themeTag,
    "#恋愛心理",
    "#自己受容",
    "#Mu",
    "#なんでわかるの",
  ]);
}

function calculateMuLeadScore(input: TikTokRadarPostIdeaInput, totalScore: number) {
  const text = buildSearchText(input);
  const hasMirrorHook =
    text.includes("なんで") ||
    text.includes("見抜") ||
    text.includes("本当は") ||
    text.includes("実は") ||
    text.includes("気づいて");
  const hasMuFit =
    text.includes("相手の気持ち") ||
    text.includes("自己否定") ||
    text.includes("自分の価値") ||
    text.includes("苦しい") ||
    text.includes("不安");
  const hasSaveSignal = text.includes("保存") || text.includes("見返す");

  return clamp(totalScore + (hasMirrorHook ? 3 : 0) + (hasMuFit ? 3 : 0) + (hasSaveSignal ? 2 : 0), 0, 20);
}

function calculateViralFormatScore(input: TikTokRadarPostIdeaInput) {
  const hook = cleanText(input.hook_text);
  const caption = cleanText(input.caption_text);
  const topComment = cleanText(input.top_comment);
  const text = `${hook} ${caption} ${topComment}`;

  const conciseHook = hook.length > 0 && hook.length <= 48;
  const hasQuestion = /[？?]/.test(hook) || text.includes("なぜ") || text.includes("なんで");
  const hasCommentSignal = topComment.length > 0;
  const hasRepeatableFrame =
    text.includes("特徴") ||
    text.includes("サイン") ||
    text.includes("理由") ||
    text.includes("共通点") ||
    text.includes("チェック");

  return clamp(
    2 +
      (conciseHook ? 1 : 0) +
      (hasQuestion ? 1 : 0) +
      (hasCommentSignal ? 1 : 0) +
      (hasRepeatableFrame ? 1 : 0),
    0,
    5
  );
}

function pickRecommendedAction(muLeadScore: number, viralFormatScore: number, totalScore: number) {
  if (muLeadScore >= 16 && viralFormatScore >= 4) {
    return "今日の投稿候補。Mu導線型か見抜き型でそのまま台本化できます。";
  }

  if (muLeadScore >= 14) {
    return "Mu導線向き。冒頭を短くして、最後にMu体験への一文を入れると使いやすいです。";
  }

  if (viralFormatScore >= 4 && totalScore >= 10) {
    return "TikTok形式向き。保存型か共感型として調整すると使えます。";
  }

  if (totalScore >= 8) {
    return "素材として保留。共鳴語を増やしてから投稿案化してください。";
  }

  return "市場メモとして保存。投稿化は急がず、似た素材を追加して比較してください。";
}

function buildSofiaStrategyNote({
  themeName,
  muLeadScore,
  viralFormatScore,
  totalScore,
  recommendedAction,
}: {
  themeName: string;
  muLeadScore: number;
  viralFormatScore: number;
  totalScore: number;
  recommendedAction: string;
}) {
  return [
    `Sofia戦略メモ: ${themeName}の素材です。`,
    `共鳴合計 ${totalScore} / Mu導線 ${muLeadScore} / TikTok形式 ${viralFormatScore}。`,
    recommendedAction,
    "外向きのバズだけでなく、『これ私のことだ』『Muに聞きたい』へつながる言葉を優先してください。",
  ].join("\n");
}

export function buildTikTokRadarPostIdea(
  input: TikTokRadarPostIdeaInput
): TikTokRadarPostIdea {
  const theme = pickTheme(input);
  const keyword = cleanText(input.keyword);
  const hook = cleanText(input.hook_text);
  const reactionWords = cleanText(input.reaction_words);
  const resonanceWords = cleanText(input.resonance_words);

  const totalScore =
    scoreNumber(input.why_known_score) +
    scoreNumber(input.resonance_score) +
    scoreNumber(input.save_intent_score);

  const muLeadScore = calculateMuLeadScore(input, totalScore);
  const viralFormatScore = calculateViralFormatScore(input);
  const recommendedAction = pickRecommendedAction(muLeadScore, viralFormatScore, totalScore);
  const sofiaStrategyNote = buildSofiaStrategyNote({
    themeName: theme.name,
    muLeadScore,
    viralFormatScore,
    totalScore,
    recommendedAction,
  });

  const scoreLabel =
    totalScore >= 13
      ? "投稿候補として強い"
      : totalScore >= 10
        ? "投稿候補として使える"
        : totalScore >= 7
          ? "調整すれば使える"
          : "素材として保留";

  const opening = hook || fallbackOpening(theme);

  const body = [
    opening,
    "",
    `本当に苦しいのは、${theme.pain}です。`,
    `だから必要なのは、無理に答えを出すことではなく、${theme.shift}です。`,
  ].join("\n");

  const muLead = [
    "その苦しさがどこから来ているのか、Muが映します。",
    "相手の答えを当てるためではなく、あなたの中で止まっている場所を見つけるためです。",
  ].join("\n");

  const hashtags = buildBaseHashtags(theme.tag, keyword);

  const empathyOpening =
    hook || `${theme.name}で苦しい人へ。まず責めなくて大丈夫です。`;

  const insightOpening =
    resonanceWords || theme.direct;

  const saveOpening =
    reactionWords.includes("保存") || reactionWords.includes("見返す")
      ? "あとで見返したくなる人は、ここを覚えておいてください。"
      : `${theme.name}で何度も同じところに戻ってしまう人へ。`;

  const muOpening = "なんでこんなに苦しいのか、Muが映します。";

  const variants: TikTokRadarPostIdeaVariant[] = [
    {
      title: "共感型",
      description: "最初に「それ私」と思わせる投稿案",
      opening: empathyOpening,
      body: [
        empathyOpening,
        "",
        `つらいのは弱いからではありません。${theme.pain}が起きているからです。`,
        `だから今見るべきなのは、気持ちを消すことではなく、${theme.shift}です。`,
      ].join("\n"),
      muLead:
        "その苦しさがどこから来ているのか、Muが映します。まずは、あなたの中で止まっている場所を見つけます。",
      hashtags,
    },
    {
      title: "見抜き型",
      description: "「なんでわかるの？」を起こす投稿案",
      opening: insightOpening,
      body: [
        insightOpening,
        "",
        `表面では別のことに見えていても、奥では${theme.pain}が起きています。`,
        `そこに気づくと、次に見る場所が変わります。`,
      ].join("\n"),
      muLead:
        "Muは、相手の答えを当てるためではなく、あなたの中でまだ言葉になっていないズレを映します。",
      hashtags,
    },
    {
      title: "保存型",
      description: "あとで見返したくなる投稿案",
      opening: saveOpening,
      body: [
        saveOpening,
        "",
        `苦しいときほど、見る場所を間違えやすくなります。`,
        `相手の反応ではなく、${theme.shift}。`,
        "ここを思い出すだけで、流れは少し変わります。",
      ].join("\n"),
      muLead:
        "迷ったときは、Muにそのまま話してください。今どこで止まっているのかを、一緒に映します。",
      hashtags,
    },
    {
      title: "Mu導線型",
      description: "Muへの登録・体験につなげる投稿案",
      opening: muOpening,
      body: [
        muOpening,
        "",
        `同じことで苦しくなるとき、必要なのは根性ではありません。`,
        `必要なのは、${theme.pain}を見つけることです。`,
        "Muは、その見落としている場所を言葉にします。",
      ].join("\n"),
      muLead:
        "Muで、今のあなたの状態をそのまま話してみてください。答えを急がず、まず見えていない場所を映します。",
      hashtags,
    },
  ];

  return {
    opening,
    body,
    muLead,
    hashtags,
    totalScore,
    scoreLabel,
    muLeadScore,
    viralFormatScore,
    recommendedAction,
    sofiaStrategyNote,
    variants,
  };
}
