// src/lib/iros/conversation/signals.ts
// iros — Conversation Signals (phase11)
// 目的：ユーザー文から「会話に必要な分岐」を“例文なし”で検出する。
// 方針：
// - 固定の場面ワード（会議/朝等）を使わない
// - 相談（迷い/不安）も対象にする
// - 判定は軽く、誤判定しても致命傷にならない（branch側で吸収）

export type ConvSignals = {
  repair: boolean;
  stuck: boolean;
  detail: boolean;
  topicHint: string | null;
};

function norm(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim();
}

function includesAny(t: string, arr: string[]): boolean {
  return arr.some((w) => t.includes(w));
}

function detectRepair(t: string): boolean {
  if (!t) return false;

  const hasQuestionMark = t.includes('？') || t.includes('?');

  const hasCorrection =
    t.includes('違う') ||
    t.includes('ちがう') ||
    t.includes('それじゃない') ||
    t.includes('それじゃなくて') ||
    t.includes('それではなく') ||
    t.includes('そこじゃない') ||
    t.includes('そこではない') ||
    t.includes('そこじゃなくて');

  const hasRecallClaim =
    t.includes('さっき') ||
    t.includes('前に') ||
    t.includes('もう言') ||
    t.includes('言った') ||
    t.includes('話した') ||
    t.includes('聞いた') ||
    t.includes('聞いたんだよ') ||
    t.includes('聞いたよ') ||
    t.includes('って聞いた') ||
    t.includes('〜って聞いた') ||
    t.includes('さっき聞いた') ||
    t.includes('前に聞いた');

  const hasAnswerDemand =
    t.includes('答えて') ||
    t.includes('ちゃんと答えて') ||
    t.includes('答え') ||
    t.includes('教えて') ||
    t.includes('一文で') ||
    t.includes('はぐらかさず') ||
    t.includes('そのまま答えて');

  const hasRepairPhrase =
    t.includes('さっき言った') ||
    t.includes('さっき聞いた') ||
    t.includes('前に言った') ||
    t.includes('前に聞いた') ||
    t.includes('同じこと') ||
    t.includes('もう一回') ||
    t.includes('もう一度') ||
    t.includes('ちゃんと') ||
    t.includes('元の質問') ||
    t.includes('元の問い') ||
    t.includes('その質問') ||
    t.includes('そこじゃない');

  // 最優先: 修復要求の明示
  if ((hasCorrection && hasAnswerDemand) || (hasRecallClaim && hasAnswerDemand)) {
    return true;
  }

  // 「ちがう、聞いたんだよ」「それじゃない、答えて」型
  if (hasCorrection && hasRecallClaim) {
    return true;
  }

  // 元質問への差し戻し
  if (hasRepairPhrase && (hasAnswerDemand || hasQuestionMark)) {
    return true;
  }

  // 「〜って聞いたんだよ」単体でも十分強い
  if (
    t.includes('って聞いたんだよ') ||
    t.includes('って聞いたよ') ||
    t.includes('何ができるのって聞いた') ||
    t.includes('何ができるの？って聞いた') ||
    t.includes('何ができるのって聞いたんだよ')
  ) {
    return true;
  }

  // 短文でも強い否定修正
  if (
    t === 'ちがう' ||
    t === '違う' ||
    t === 'それじゃない' ||
    t === 'そこじゃない'
  ) {
    return true;
  }

  const keys = [
    'さっき',
    'もう言',
    '言った',
    '話した',
    '聞いた',
    '今言',
    '前に',
    '繰り返',
    'また',
    '違う',
    'ちがう',
    'それじゃない',
    'それじゃなくて',
    'それではなく',
    'そこじゃない',
    'わかって',
    '覚えて',
    '答えて',
    'ちゃんと答えて',
    'って聞いた',
    '聞いたんだよ',
    '聞いたよ',
    '元の質問',
    '元の問い',
  ];

  return includesAny(t, keys) && (
    hasQuestionMark ||
    t.includes('ない') ||
    t.includes('答えて') ||
    t.includes('答え') ||
    t.includes('ちゃんと')
  );
}

function detectDetail(t: string): boolean {
  // detail は「本当に情報が無い」時だけ立てる（立ちすぎると会話が戻る）
  if (!t) return true;

  // 代名詞・相づち・曖昧だけ（ここは detail を立てる）
  const vagueOnly =
    t === 'それ' ||
    t === 'これ' ||
    t === 'あれ' ||
    t === 'うん' ||
    t === 'はい' ||
    t === 'そう' ||
    t === 'そうです' ||
    t === 'わからない' ||
    t === 'よくわからない';

  // 「特にない/なし」は detail 候補（ただし押し付けない）
  const nothing =
    t.includes('特にない') ||
    t === 'ない' ||
    t === 'なし' ||
    t === '無い' ||
    t === '無し';

  // “名詞ラベル短文（上司です/会社です等）”は detail を立てない
  // → ここは復元＋前進で会話が成立できるため
  const labelShort =
    (t.endsWith('です') || t.endsWith('です。')) &&
    t.length <= 6 &&
    !t.includes('から') &&
    !t.includes('ので') &&
    !t.includes('けど') &&
    !t.includes('が');

  if (labelShort) return false;

  // 極端に短い1語感情（例：つらい/しんどい）だけは detail を立てる
  // ※ただし stuck 側でも拾うので軽く
  const shortEmotion =
    t.length <= 4 && includesAny(t, ['つら', 'しんど', '怖', '不安', '嫌', '無理']);

  return vagueOnly || nothing || shortEmotion;
}

function detectStuck(t: string): boolean {
  if (!t) return false;

  const negOnly =
    (t === '無理' ||
      t === 'わからない' ||
      t === '知らない' ||
      t === 'できない' ||
      t === 'ない' ||
      t === '無い') && t.length <= 6;

  const loopish =
    includesAny(t, ['同じ', '変わらない', 'また', '繰り返し', 'いつも']) ||
    (t.includes('どう') && t.includes('する') && t.length <= 10);

  return negOnly || loopish;
}

function detectTopicHint(t: string): string | null {
  if (!t) return null;

  const pairs: Array<[string, string[]]> = [
    ['仕事・キャリア', ['会社', '上司', '同僚', '部下', '職場', '転職', '退職', '評価', '給料', '残業']],
    ['人間関係', ['友達', '家族', 'パートナー', '恋人', '夫', '妻', '彼', '彼女', '関係']],
    ['不安・ストレス', ['不安', '怖い', '恐', '緊張', 'ストレス', 'しんどい', 'つらい', '疲れ']],
    ['迷い・選択', ['悩', '迷', '決め', '選', 'どうする', 'やめる', '続ける']],
  ];

  for (const [label, ws] of pairs) {
    if (includesAny(t, ws)) return label;
  }
  return null;
}

export function computeConvSignals(userText: string): ConvSignals {
  const t = norm(userText);

  const repair = detectRepair(t);
  const detail = detectDetail(t);
  const stuck = detectStuck(t);

  const topicHint = detectTopicHint(t);

  return { repair, stuck, detail, topicHint };
}
