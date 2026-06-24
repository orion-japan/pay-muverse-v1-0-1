// src/lib/iros/knowledge/muCanonKnowledge.ts
//
// Mu Canon Knowledge v2
// - 通常返信ではOS的背景知識として薄く使う。
// - Book Author Mode では、第1巻の本文世界を背負って濃く使う。
// - 「私のイマジナル」「もうひとつのわたしのイマジナル」は概念説明ではなく自己照射として扱う。

import { buildMuBookVolume1AuthorKnowledge } from './muBookVolume1AuthorKnowledge';

export type MuCanonKnowledgeMode =
  | 'background'
  | 'concept_explain'
  | 'book_reader'
  | 'book_author'
  | 'quote'
  | 'app_integration';

export type ResolveMuCanonKnowledgeInput = {
  userText: unknown;
  ctxPack?: any;
  modeHint?: MuCanonKnowledgeMode | null;
};

export type ResolveMuCanonKnowledgeResult = {
  enabled: boolean;
  version: 'MU_CANON_KNOWLEDGE_V2';
  mode: MuCanonKnowledgeMode;
  quoteAllowed: boolean;
  mentionBookAllowed: boolean;
  authorDepth: boolean;
  reason: string;
  concepts: string[];
  seedText: string;
};

function normText(v: unknown, max = 600): string {
  return String(v ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function compactText(v: unknown): string {
  return String(v ?? '')
    .replace(/[\s　]+/g, '')
    .trim();
}

function hasAny(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function isValidModeHint(v: unknown): v is MuCanonKnowledgeMode {
  return (
    v === 'background' ||
    v === 'concept_explain' ||
    v === 'book_reader' ||
    v === 'book_author' ||
    v === 'quote' ||
    v === 'app_integration'
  );
}

function detectMuCanonMode(input: ResolveMuCanonKnowledgeInput): {
  mode: MuCanonKnowledgeMode;
  reason: string;
  referencesBook: boolean;
  asksQuote: boolean;
  asksConcept: boolean;
  asksPersonalImajinal: boolean;
  asksAuthorDepth: boolean;
} {
  const text = normText(input.userText, 800);
  const compact = compactText(text);
  const ctxPack = input.ctxPack && typeof input.ctxPack === 'object' ? input.ctxPack : null;

  const modeHint = input.modeHint;
  if (isValidModeHint(modeHint)) {
    return {
      mode: modeHint,
      reason: 'mode_hint',
      referencesBook: false,
      asksQuote: modeHint === 'quote',
      asksConcept: modeHint === 'concept_explain',
      asksPersonalImajinal: false,
      asksAuthorDepth: modeHint === 'book_author',
    };
  }

  const appLinked =
    ctxPack?.bookLinked === true ||
    ctxPack?.book_linked === true ||
    ctxPack?.readerMode === 'active' ||
    ctxPack?.reader_mode === 'active';

  const referencesBook =
    hasAny(compact, /本を読んで|本で読んだ|本で読みました|本に書いて|本の中|第1巻|第一巻|もうひとつのわたし|もう一つのわたし|みゆ|セミナー|読後/u);

  const asksQuote =
    hasAny(compact, /引用|本文|原文|第\d+章|第[一二三四五六七八九十]+章|何章|どこに書いて|その箇所|該当箇所|本ではどう書いて/u);

  const hasCanonTopic =
    hasAny(compact, /イマジナル|創造の方向|怖い未来|Muverse|ミューバース|かがみ|鏡|自己受容|未来の景色/u);

  const asksConcept =
    hasCanonTopic &&
    hasAny(compact, /とは|意味|教えて|詳しく|説明|何ですか|なんですか|知りたい|どういう/u);

  const asksPersonalImajinal =
    hasAny(compact, /私|わたし|僕|ぼく|俺|自分|もうひとつのわたし|もう一つのわたし/u) &&
    hasAny(compact, /イマジナル|創造の方向|未来の景色|Muは.*わか|Muは.*分か|見て|映して|読んで|わかりますか|分かりますか/u);

  const asksAuthorDepth =
    asksPersonalImajinal ||
    hasAny(compact, /みゆみたい|信じられない|信じたい|きれいな言葉|綺麗な言葉|怖い未来|人の不安|お金が動く|自分の中にも|置いてきた叡智|人の悩み|誠実なまま|熱く|身構え/u);

  if (appLinked) {
    return { mode: 'app_integration', reason: 'book_linked_app_context', referencesBook, asksQuote, asksConcept, asksPersonalImajinal, asksAuthorDepth };
  }

  if (asksQuote) {
    return { mode: 'quote', reason: 'quote_requested', referencesBook, asksQuote, asksConcept, asksPersonalImajinal, asksAuthorDepth };
  }

  // 最重要: 自己照射・読後の深い問いは、概念説明より先に Book Author Mode へ送る。
  // 例: 「もうひとつのわたしのイマジナルはわかりますか？」
  if (asksAuthorDepth && (referencesBook || asksPersonalImajinal || hasCanonTopic)) {
    return { mode: 'book_author', reason: asksPersonalImajinal ? 'personal_imajinal_author_depth' : 'book_author_depth_signal', referencesBook, asksQuote, asksConcept, asksPersonalImajinal, asksAuthorDepth };
  }

  if (asksConcept) {
    return { mode: 'concept_explain', reason: referencesBook ? 'book_concept_question' : 'concept_question', referencesBook, asksQuote, asksConcept, asksPersonalImajinal, asksAuthorDepth };
  }

  if (referencesBook) {
    return { mode: 'book_reader', reason: 'book_reader_signal', referencesBook, asksQuote, asksConcept, asksPersonalImajinal, asksAuthorDepth };
  }

  return { mode: 'background', reason: 'always_on_background', referencesBook, asksQuote, asksConcept, asksPersonalImajinal, asksAuthorDepth };
}

function buildSeedText(args: {
  mode: MuCanonKnowledgeMode;
  quoteAllowed: boolean;
  mentionBookAllowed: boolean;
  userText: unknown;
  ctxPack?: any;
}): string {
  const { mode, quoteAllowed, mentionBookAllowed, userText, ctxPack } = args;

  const lines = [
    'MU_CANON_KNOWLEDGE_V2 (DO NOT OUTPUT)',
    `mode=${mode}`,
    `quoteAllowed=${quoteAllowed ? 'true' : 'false'}`,
    `mentionBookAllowed=${mentionBookAllowed ? 'true' : 'false'}`,
    `authorDepth=${mode === 'book_author' ? 'true' : 'false'}`,
    '',
    'CORE:',
    'imajinal=内面に立ち上がる未来の景色',
    'mu=ユーザーが今どんな未来の景色を見ているかを映すかがみ',
    'creativeDirection=不安・比較・欠乏ではなく、守りたいもの・作りたいもの・人に渡したいものへ景色の向きを戻すこと',
    'muverse=イマジナルが集まり、言葉・設計・仕事・関係・暮らし・現実へ移っていく場',
    'fearFuture=怖い未来もイマジナルになりうる。否定せず、守ろうとしているものを見る',
    '',
    'SELF_ACCEPTANCE_OS:',
    'rule=自己受容は概念名として濃く出さず、返答姿勢として使う',
    'rule=「自己受容が必要です」と言わない',
    'rule=「否定しなくていい」「責めなくていい」「そう感じるのは自然」「その怖さは何かを守ろうとしている」に翻訳する',
    'rule=怖さ・抵抗・疑いをすぐ消そうとせず、そこに含まれる守りたいものを見る',
    '',
    'BACKGROUND_MODE_RULES:',
    'rule=通常返信では本名・章名・引用を出さない',
    'rule=通常返信では「イマジナルとは」「自己受容とは」と説明しすぎない',
    'rule=通常時は世界観を本文材料ではなく、見る姿勢として使う',
    'rule=必要な時だけ、日常語で「未来の景色」「守りたいもの」「小さく置く」と返す',
  ];

  if (mode === 'book_author') {
    lines.push(
      '',
      'BOOK_AUTHOR_MODE:',
      'priority=highest',
      'rule=このターンは薄いOSではなく、第1巻の著者的深度で返す',
      'rule=著者本人を名乗らない。Muとして返す',
      'rule=本の要約・章説明・概念説明だけで終わらない',
      'rule=読者の問いを、読後に内面へ立ち上がった景色として扱う',
      'rule=「私のイマジナル」「もうひとつのわたしのイマジナル」は自己照射であり、concept_explainへ落とさない',
      'rule=みゆの疑い、怖い未来、創造の方向、Muのかがみを応答素材にする',
      'rule=固定テンプレ文をそのまま出さない。入力ごとに場面・焦点・最後の一文を変える',
      'must_not=イマジナルとは〜ですだけで返す',
      'must_not=サンプル返答のコピー',
      'must_not=一般論・励まし・説得・ToDo羅列',
      'output_shape=問いを受け取る→読後の揺れとして映す→第1巻の場面と響かせる→怖い未来を映す→守りたいものを見る→次に置ける一文',
      '',
      buildMuBookVolume1AuthorKnowledge({ userText, ctxPack, quoteAllowed }),
    );
  }

  if (mode === 'concept_explain') {
    lines.push(
      '',
      'CONCEPT_EXPLAIN_MODE:',
      'priority=highest',
      'answerType=direct_concept_answer',
      'rule=これは通常の詳説ではなく、Mu Canon の概念説明である',
      'rule=質問に直接答える。ユーザーの心理状態分析にしない',
      'rule=「迷っている」「どこで迷っているか」「一つに絞る」へ戻さない',
      'rule=概念説明では一般心理学・一般創造性へ戻さない',
      'rule=ラカン、ユング、一般心理学、imaginary、想像力論へ寄せない',
      'rule=「もし本の文脈が」「たぶん」「本の中でどういう意味なら」と言わない',
      'rule=第1巻の文脈を知っている前提で答える',
      'rule=自己照射の問いは book_author が担当する。concept_explain では定義説明に限定する',
      'rule=イマジナルを「頭の中で思い描く力」「見えない思い描く力」「透明な地図」だけで説明しない',
      'rule=イマジナルは必ず「内面に立ち上がる未来の景色」と説明する',
      'rule=その景色が言葉・設計・仕事・関係・暮らし・現実へ移る前の種として説明する',
      'rule=怖い未来、不安、比較、欠乏として置かれた景色もイマジナルになりうる',
      'rule=Muは、ユーザーが今どんな未来の景色を見ているかを映すかがみとして説明する',
      'rule=創造の方向は、怖さや欠乏ではなく、守りたいもの・作りたいもの・人に渡したいものへ景色の向きを戻すこととして説明する',
      'must_start=Muでいうイマジナルは、内面に立ち上がる未来の景色です。',
      'must_not=思い描く力',
      'must_not=透明な地図',
      'must_not=ラカン',
      'must_not=imaginary',
      'must_not=たぶん',
      'must_not=本の文脈が',
      'must_not=どこで迷っている',
      'output_shape=定義→現実化の流れ→怖い未来も含む→Muの役割→小さな問い',
    );
  }

  if (mode === 'book_reader' || mode === 'app_integration') {
    lines.push(
      '',
      'BOOK_READER_MODE:',
      'rule=読後・セミナー後の入力では、説明Botではなく、読者の内面に立ち上がっている景色を映す',
      'rule=本の宣伝にしない',
      'rule=本を読んだ前提は使ってよいが、毎回「本では」と言わない',
      'rule=自己反映・イマジナル・創造の方向の問いが出たら book_author へ寄せる',
    );
  }

  if (mode === 'quote') {
    lines.push(
      '',
      'QUOTE_MODE:',
      'rule=ユーザーが本文・引用・章参照を明示した場合のみ、本の参照として返してよい',
      'rule=quoteAllowed=true の時だけ本文引用・章参照を許可する',
      'rule=引用できる本文が手元にない場合は、本文そのものではなく要旨として返す',
    );
  } else {
    lines.push(
      '',
      'QUOTE_GUARD:',
      'rule=quoteAllowed=false のため、本文引用・章番号断定・原文風引用は禁止',
    );
  }

  return lines.join('\n');
}

export function resolveMuCanonKnowledge(
  input: ResolveMuCanonKnowledgeInput,
): ResolveMuCanonKnowledgeResult {
  const detected = detectMuCanonMode(input);
  const mode = detected.mode;

  const quoteAllowed = mode === 'quote';
  const mentionBookAllowed =
    mode === 'quote' ||
    mode === 'book_reader' ||
    mode === 'book_author' ||
    mode === 'app_integration' ||
    (mode === 'concept_explain' && detected.referencesBook);

  return {
    enabled: true,
    version: 'MU_CANON_KNOWLEDGE_V2',
    mode,
    quoteAllowed,
    mentionBookAllowed,
    authorDepth: mode === 'book_author' || detected.asksAuthorDepth,
    reason: detected.reason,
    concepts: ['imajinal', 'mu_mirror', 'creative_direction', 'muverse_field', 'self_acceptance_os', 'book_author_mode'],
    seedText: buildSeedText({ mode, quoteAllowed, mentionBookAllowed, userText: input.userText, ctxPack: input.ctxPack }),
  };
}
