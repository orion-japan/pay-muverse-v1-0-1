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

export type TopicSummarizerResult = {
  conversationLine: string | null;
  topicDigest: string | null;
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

  const digestParts = [
    normalizeText((args.historyDigestV1 as any)?.topic),
    normalizeText((args.historyDigestV1 as any)?.summary),
    ...(((args.historyDigestV1 as any)?.keywords ?? []) as string[]).map((v) => normalizeText(v)),
  ].filter(Boolean);

  const situationParts = [
    normalizeText(args.situationSummary),
    normalizeText(args.situationTopic),
  ].filter(Boolean);

  const historyParts = collectHistoryText(args.historyForWriter, 6);

  // ✅ 最新 userText を最優先
  // - userText がある時は、それ単体を主材料にする
  // - 補助材料は少量だけ後ろに添える
  if (currentUser) {
    return [
      currentUser,
      ...digestParts.slice(-1),
      ...situationParts.slice(-1),
      ...historyParts.slice(-2),
    ]
      .filter(Boolean)
      .join('\n');
  }

  // userText がない時だけ、補助材料で組む
  return [...digestParts, ...situationParts, ...historyParts]
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

function pickConversationLine(scores: Record<ThemeKey, number>): string | null {
  const has = (k: ThemeKey) => scores[k] > 0;

  if (has('rewind') && has('organize')) return '思考の巻き戻り';
  if (has('rewind') && has('reconfirm')) return '過去テーマの再確認';
  if (has('rewind') && has('memory')) return '過去感覚への逆戻り';
  if (has('rewind')) return '前の感じへの逆戻り';

  if (has('work') && has('anxiety')) return '仕事不安の整理';
  if (has('relationship') && has('anxiety')) return '関係不安の整理';
  if (has('health') && has('stuck')) return '体調由来の停滞';
  if (has('forward') && has('anxiety')) return '前進前の迷い';
  if (has('forward') && has('organize')) return '前進前の整理';
  if (has('stuck') && has('emotion')) return '感情停滞の整理';
  if (has('memory') && has('reconfirm')) return '過去感覚の再確認';
  if (has('work')) return '仕事テーマの揺れ';
  if (has('relationship')) return '関係テーマの揺れ';
  if (has('health')) return '体調テーマの整理';
  if (has('anxiety')) return '不安感の整理';
  if (has('stuck')) return '停滞感の観測';
  if (has('forward')) return '前進準備の兆し';
  if (has('organize')) return '状況の整理段階';
  if (has('memory')) return '過去テーマの浮上';

  return null;
}

function pickTopicDigest(
  scores: Record<ThemeKey, number>,
  keywords: string[],
  rawText: string,
): string | null {
  const has = (k: ThemeKey) => scores[k] > 0;
  const lead = keywords.slice(0, 2).join('・');

  if (has('rewind') && has('organize')) {
    return '前に進む前に、過去感覚へ戻って整理し直している流れ';
  }
  if (has('rewind') && has('reconfirm')) {
    return '以前のテーマや感覚をもう一度確かめ直している状態';
  }
  if (has('work') && has('anxiety')) {
    return '仕事や働き方にまつわる不安や迷いを整え直している段階';
  }
  if (has('relationship') && has('anxiety')) {
    return '相手との距離感や関係の揺れを見直している途中';
  }
  if (has('health') && has('stuck')) {
    return '体や気力の重さが先に出て、動きづらさにつながっている状態';
  }
  if (has('forward') && has('organize')) {
    return '動き出す前に、順番や気持ちを整えている過程';
  }
  if (has('stuck') && has('emotion')) {
    return '感情の重さや詰まりを言葉にしながらほどこうとしている状態';
  }
  if (has('anxiety')) {
    return '不安や迷いの正体を見極めながら整えようとしている流れ';
  }
  if (has('forward')) {
    return 'まだ小さくても、前へ進むための準備が立ち上がっている段階';
  }
  if (has('organize')) {
    return '散らばった感覚や状況を整え直している途中';
  }

  if (lead) {
    return truncateJa(`${lead}を中心に今の流れを捉え直している状態`, 40);
  }

  const fallback = truncateJa(rawText, 32);
  if (fallback) return truncateJa(`${fallback}に関する流れを観測中`, 40);

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
      keywords: [],
    };
  }

  const scores = detectThemes(rawText);
  const keywords = extractKeywords(rawText);

  const conversationLine = truncateJa(
    pickConversationLine(scores) ?? '',
    18,
  ) || null;

  const topicDigest = truncateJa(
    pickTopicDigest(scores, keywords, rawText) ?? '',
    40,
  ) || null;

  return {
    conversationLine,
    topicDigest,
    keywords,
  };
}
