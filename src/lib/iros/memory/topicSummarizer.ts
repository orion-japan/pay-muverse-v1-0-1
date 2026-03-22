// src/lib/iros/memory/topicSummarizer.ts
// iros — Topic Summarizer v1
//
// 目的:
// - userText / history / digest / situation をもとに
//   conversationLine / topicDigest / keywords を生成する
// - LLM 不使用の軽量 summarizer
//
// 方針:
// - まずは「意味ラベル」を安定生成する
// - conversationLine は短め（目安 6〜18文字）
// - topicDigest は少し広め（目安 12〜40文字）
// - Semantic Recall 用に keywords も返す

export type TopicSummarizerArgs = {
  userText?: string | null;
  historyForWriter?: Array<
    | string
    | {
        role?: string | null;
        content?: string | null;
        text?: string | null;
      }
  > | null;
  historyDigestV1?: {
    topic?: string | null;
    summary?: string | null;
    keywords?: string[] | null;
  } | null;
  situationSummary?: string | null;
  situationTopic?: string | null;
};

export type TopicDigestV2 = {
  mainTopic: string | null;
  subTopic: string | null;
  summary: string | null;
  keywords: string[];
};

export type TopicSummarizerResult = {
  conversationLine: string | null;
  topicDigest: string | null;
  topicDigestV2: TopicDigestV2 | null;
  keywords: string[];
};

type ThemeKey =
  | 'rewind'
  | 'reconfirm'
  | 'work'
  | 'relationship'
  | 'health'
  | 'anxiety'
  | 'stuck'
  | 'forward'
  | 'organize'
  | 'emotion'
  | 'memory';

const STOP_WORDS = new Set([
  'こと',
  '感じ',
  'よう',
  'それ',
  'これ',
  'あれ',
  'もの',
  'ため',
  'いま',
  '今',
  '最近',
  'ちょっと',
  '少し',
  'かな',
  'かも',
  'です',
  'ます',
  'する',
  'した',
  'して',
  'いる',
  'ある',
  'ない',
  'なる',
  'だった',
  'だけ',
  'でも',
  'とか',
  'よく',
  'もう',
  'また',
]);

const THEME_TERMS: Record<ThemeKey, string[]> = {
  rewind: [
    '戻る',
    '戻ってる',
    '巻き戻り',
    '逆行',
    '後退',
    '前の感じ',
    '前に戻る',
    'ぶり返す',
    '再浮上',
    'また同じ',
  ],
  reconfirm: [
    '再確認',
    '確認し直す',
    '思い出す',
    'なんだっけ',
    'もう一度',
    '見直す',
    '確かめる',
    '整理し直す',
  ],
  work: [
    '仕事',
    '職場',
    '会社',
    '転職',
    '働く',
    '業務',
    'キャリア',
    '上司',
    '部下',
    '評価',
  ],
  relationship: [
    '人間関係',
    '相手',
    '関係',
    '恋愛',
    '夫婦',
    '家族',
    '友達',
    '友人',
    '距離感',
    'つながり',
  ],
  health: [
    '体調',
    'しんどい',
    '疲れ',
    '眠い',
    '眠れない',
    'だるい',
    '頭が重い',
    '休みたい',
    '気力',
    '元気',
  ],
  anxiety: [
    '不安',
    'こわい',
    '怖い',
    '心配',
    '迷い',
    '重い',
    '落ち着かない',
    '焦り',
    '不透明',
    '揺れる',
  ],
  stuck: [
    '止まる',
    '進めない',
    '動けない',
    'やる気が出ない',
    '固まる',
    '詰まる',
    '停滞',
    '行き詰まり',
  ],
  forward: [
    '進みたい',
    '続けたい',
    '動きたい',
    '前に進む',
    'やってみる',
    '始めたい',
    '切り替える',
    '前進',
  ],
  organize: [
    '整理',
    '整える',
    '落ち着ける',
    '順番',
    '片づける',
    '整え直す',
    'まとめる',
  ],
  emotion: [
    '気持ち',
    '感情',
    'モヤモヤ',
    '苦しい',
    'つらい',
    '悲しい',
    '怒り',
    'イライラ',
  ],
  memory: [
    '前に',
    '前回',
    '過去',
    '昔',
    '思い出',
    '記憶',
    'この前',
    '以前',
  ],
};

const KEYWORD_SURFACE_MAP: Array<{ canonical: string; variants: string[] }> = [
  { canonical: '巻き戻り', variants: ['戻る', '戻ってる', '巻き戻り', '逆行', '後退', '再浮上'] },
  { canonical: '再確認', variants: ['再確認', '確認し直す', 'なんだっけ', 'もう一度', '見直す', '思い出す'] },
  { canonical: '仕事', variants: ['仕事', '職場', '会社', '転職', '働く', '業務', 'キャリア'] },
  { canonical: '人間関係', variants: ['人間関係', '相手', '関係', '恋愛', '夫婦', '家族', '友達'] },
  { canonical: '体調', variants: ['体調', 'しんどい', '疲れ', '眠い', '眠れない', 'だるい', '気力'] },
  { canonical: '不安', variants: ['不安', 'こわい', '怖い', '心配', '迷い', '焦り', '落ち着かない'] },
  { canonical: '停滞', variants: ['止まる', '進めない', '動けない', 'やる気が出ない', '停滞', '詰まる'] },
  { canonical: '前進', variants: ['進みたい', '続けたい', '動きたい', '前進', '始めたい', '切り替える'] },
  { canonical: '整理', variants: ['整理', '整える', '順番', '片づける', '整え直す', 'まとめる'] },
  { canonical: '感情', variants: ['気持ち', '感情', 'モヤモヤ', '苦しい', 'つらい', '悲しい', '怒り'] },
  { canonical: '過去テーマ', variants: ['前に', '前回', '過去', '昔', '記憶', 'この前', '以前'] },
];

function normalizeText(input: string | null | undefined): string {
  if (!input) return '';
  return String(input)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/[“”"'`’]/g, '')
    .trim();
}

function truncateJa(input: string, max: number): string {
  const s = normalizeText(input);
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max);
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function collectHistoryText(
  historyForWriter: TopicSummarizerArgs['historyForWriter'],
  limit = 6,
): string[] {
  if (!historyForWriter || !Array.isArray(historyForWriter)) return [];

  const picked = historyForWriter.slice(-Math.max(limit * 2, 8));

  const userTexts: string[] = [];
  const assistantTexts: string[] = [];

  for (const item of picked) {
    if (!item || typeof item !== 'object') continue;

    const role = normalizeText((item as any).role ?? '').toLowerCase();
    const v = normalizeText((item as any).content ?? (item as any).text ?? '');
    if (!v) continue;

    if (role === 'user') {
      userTexts.push(v);
      continue;
    }

    if (role === 'assistant') {
      assistantTexts.push(v);
    }
  }

  // user を主材料にする
  const userPart = userTexts.slice(-limit);

  // assistant は補助として少量だけ使う
  const assistantPart = assistantTexts.slice(-2);

  return [...userPart, ...assistantPart];
}

function buildSourceText(args: TopicSummarizerArgs): string {
  const currentUser = normalizeText(args.userText);

  const historyDigestAny: any = args.historyDigestV1 as any;

  const digestParts = [
    normalizeText(historyDigestAny?.topic?.situationTopic),
    normalizeText(historyDigestAny?.topic?.situationSummary),
    normalizeText(historyDigestAny?.continuity?.last_user_core),
    normalizeText(historyDigestAny?.continuity?.last_assistant_core),
    ...(((historyDigestAny?.keywords ?? []) as string[]) || []).map((v) => normalizeText(v)),
  ].filter(Boolean);

  const situationParts = [
    normalizeText(args.situationTopic),
    normalizeText(args.situationSummary),
  ].filter(Boolean);

  const historyParts = collectHistoryText(args.historyForWriter, 6);

  const stableCoreParts = [
    ...digestParts.slice(0, 4),
    ...situationParts.slice(0, 2),
  ].filter(Boolean);

  const stableCore = stableCoreParts.join(' ').trim();

  const currentLooksLikeTopicShift =
    currentUser.length > 0 &&
    stableCore.length > 0 &&
    (
      (/仕事|職場|転職|会社/.test(currentUser) && /彼女|彼氏|恋愛|連絡|浮気|別な男/.test(stableCore)) ||
      (/彼女|彼氏|恋愛|連絡|浮気|別な男/.test(currentUser) && /仕事|職場|転職|会社/.test(stableCore)) ||
      (/家族|夫婦|親|子ども/.test(currentUser) && /仕事|職場|転職|会社|彼女|彼氏|恋愛/.test(stableCore))
    );

  // ✅ 根本方針
  // - 芯（digest / continuity / situation）を先に置く
  // - currentUser は差分として後ろに足す
  // - ただし明確な話題転換だけは currentUser を先頭にする
  if (currentUser) {
    if (currentLooksLikeTopicShift) {
      return [
        currentUser,
        ...stableCoreParts.slice(0, 2),
      ]
        .filter(Boolean)
        .join(' ');
    }

    return [
      stableCore,
      currentUser,
    ]
      .filter(Boolean)
      .join(' ');
  }

  return [
    stableCore,
    ...historyParts,
  ]
    .filter(Boolean)
    .join('\n');
}
function countHits(text: string, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    if (term && text.includes(term)) score += 1;
  }
  return score;
}

function detectThemes(text: string): Record<ThemeKey, number> {
  const scores = {
    rewind: 0,
    reconfirm: 0,
    work: 0,
    relationship: 0,
    health: 0,
    anxiety: 0,
    stuck: 0,
    forward: 0,
    organize: 0,
    emotion: 0,
    memory: 0,
  } satisfies Record<ThemeKey, number>;

  (Object.keys(THEME_TERMS) as ThemeKey[]).forEach((key) => {
    scores[key] = countHits(text, THEME_TERMS[key]);
  });

  return scores;
}

function extractKeywords(text: string): string[] {
  const hits: string[] = [];

  for (const row of KEYWORD_SURFACE_MAP) {
    if (row.variants.some((v) => text.includes(v))) hits.push(row.canonical);
  }

  // 補助的に日本語の長め名詞っぽい断片を拾う（超軽量）
  const chunks = text
    .split(/[\n、。,.!?！？\s]+/)
    .map((v) => normalizeText(v))
    .filter(Boolean)
    .filter((v) => v.length >= 2 && v.length <= 12)
    .filter((v) => !STOP_WORDS.has(v));

  for (const c of chunks) {
    if (
      /仕事|職場|転職|会社|不安|迷い|整理|逆行|戻|前進|体調|関係|恋愛|家族|疲れ|記憶|過去|気力|停滞/.test(c)
    ) {
      hits.push(c);
    }
  }

  return uniq(hits).slice(0, 8);
}

function pickConversationLine(
  scores: Record<ThemeKey, number>,
  keywords: string[],
  rawText: string,
): string | null {
  const has = (k: ThemeKey) => scores[k] > 0;
  const text = normalizeText(rawText);
  const lead = keywords.slice(0, 2).join('・');

  if (/彼女|彼氏|恋愛|連絡|返信|既読|未読|浮気|別な男|温度差/.test(text)) {
    if (/不安|心配|疑|浮気|別な男/.test(text)) {
      return truncateJa('恋愛の連絡不安と疑い', 24);
    }
    return truncateJa('恋愛の連絡と距離感', 24);
  }

  if (/仕事|職場|転職|会社|上司|同僚/.test(text)) {
    if (/不安|迷|しんど|疲/.test(text)) {
      return truncateJa('仕事の不安と迷い', 24);
    }
    return truncateJa('仕事の相談', 24);
  }

  if (/家族|夫婦|親|子ども/.test(text)) {
    return truncateJa('家族との関係', 24);
  }

  if (has('relationship') && has('anxiety')) return truncateJa('関係の不安', 24);
  if (has('work') && has('anxiety')) return truncateJa('仕事の不安', 24);
  if (has('health') && has('stuck')) return truncateJa('体調由来の停滞', 24);

  if (lead) return truncateJa(lead, 24);

  const fallback = truncateJa(text, 24);
  return fallback || null;
}

function pickTopicDigest(
  scores: Record<ThemeKey, number>,
  keywords: string[],
  rawText: string,
): string | null {
  const has = (k: ThemeKey) => scores[k] > 0;
  const text = normalizeText(rawText);
  const lead = keywords.slice(0, 2).join('・');

  if (/彼女|彼氏|恋愛|連絡|返信|既読|未読|浮気|別な男|温度差/.test(text)) {
    if (/浮気|別な男|疑|心配|不安/.test(text)) {
      return truncateJa('相手との連絡不安から、疑いや心配が強まっている流れ', 60);
    }
    return truncateJa('相手との連絡や距離感のズレを気にしている流れ', 60);
  }

  if (/仕事|職場|転職|会社|上司|同僚/.test(text)) {
    if (/不安|迷|辞め|続け/.test(text)) {
      return truncateJa('仕事を続けるかどうかの不安や迷いを整理している流れ', 60);
    }
    return truncateJa('仕事に関する状況や悩みを整理している流れ', 60);
  }

  if (/家族|夫婦|親|子ども/.test(text)) {
    return truncateJa('家族との関係や距離感を整理している流れ', 60);
  }

  if (has('relationship') && has('anxiety')) {
    return truncateJa('相手との関係不安や揺れを整理している流れ', 60);
  }
  if (has('work') && has('anxiety')) {
    return truncateJa('仕事にまつわる不安や迷いを整えている流れ', 60);
  }
  if (has('health') && has('stuck')) {
    return truncateJa('体調や消耗による停滞を見直している流れ', 60);
  }

  if (lead) {
    return truncateJa(`${lead}を中心に今の流れを見直している状態`, 60);
  }

  const fallback = truncateJa(text, 40);
  if (fallback) return truncateJa(`${fallback}に関する流れ`, 60);

  return null;
}


export function summarizeTopicLineV1(
  args: TopicSummarizerArgs,
): TopicSummarizerResult {
  const rawText = buildSourceText(args);
  if (!rawText) {
    return {
      conversationLine: null,
      topicDigest: null,
      topicDigestV2: null,
      keywords: [],
    };
  }

  const scores = detectThemes(rawText);
  const keywords = extractKeywords(rawText);

  const conversationLine = truncateJa(
    pickConversationLine(scores, keywords, rawText) ?? '',
    24,
  ) || null;

  const topicDigest = truncateJa(
    pickTopicDigest(scores, keywords, rawText) ?? '',
    60,
  ) || null;

  const mainTopic =
    truncateJa(
      String(args.situationTopic ?? '').trim() ||
        topicDigest ||
        conversationLine ||
        '',
      40,
    ) || null;

  const subTopic =
    truncateJa(
      String(args.situationSummary ?? '').trim() ||
        conversationLine ||
        '',
      40,
    ) || null;

  const summary =
    truncateJa(
      topicDigest ||
        String(args.situationSummary ?? '').trim() ||
        rawText,
      60,
    ) || null;

  const topicDigestV2: TopicDigestV2 | null =
    mainTopic || subTopic || summary || keywords.length > 0
      ? {
          mainTopic,
          subTopic,
          summary,
          keywords,
        }
      : null;

  return {
    conversationLine,
    topicDigest,
    topicDigestV2,
    keywords,
  };
}
