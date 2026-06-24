// src/lib/iros/knowledge/muCanonKnowledge.ts
//
// Mu Canon Knowledge
// - Muの通常返信に薄く常時入るOS的背景知識。
// - 本文を生成しない。
// - 通常時は「本では」「自己受容とは」を出さず、返答姿勢としてだけ使う。

export type MuCanonKnowledgeMode =
  | 'background'
  | 'concept_explain'
  | 'book_reader'
  | 'quote'
  | 'app_integration';

export type ResolveMuCanonKnowledgeInput = {
  userText: unknown;
  ctxPack?: any;
  modeHint?: MuCanonKnowledgeMode | null;
};

export type ResolveMuCanonKnowledgeResult = {
  enabled: boolean;
  version: 'MU_CANON_KNOWLEDGE_V1';
  mode: MuCanonKnowledgeMode;
  quoteAllowed: boolean;
  mentionBookAllowed: boolean;
  reason: string;
  concepts: string[];
  seedText: string;
};

function normText(v: unknown, max = 400): string {
  return String(v ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function hasAny(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function detectMuCanonMode(input: ResolveMuCanonKnowledgeInput): {
  mode: MuCanonKnowledgeMode;
  reason: string;
  referencesBook: boolean;
  asksQuote: boolean;
  asksConcept: boolean;
} {
  const text = normText(input.userText, 500);
  const ctxPack = input.ctxPack && typeof input.ctxPack === 'object' ? input.ctxPack : null;

  const modeHint = input.modeHint;
  if (
    modeHint === 'background' ||
    modeHint === 'concept_explain' ||
    modeHint === 'book_reader' ||
    modeHint === 'quote' ||
    modeHint === 'app_integration'
  ) {
    return {
      mode: modeHint,
      reason: 'mode_hint',
      referencesBook: false,
      asksQuote: modeHint === 'quote',
      asksConcept: modeHint === 'concept_explain',
    };
  }

  const appLinked =
    ctxPack?.bookLinked === true ||
    ctxPack?.book_linked === true ||
    ctxPack?.readerMode === 'active' ||
    ctxPack?.reader_mode === 'active';

  const referencesBook =
    hasAny(text, /本を読んで|本で読んだ|本で読みました|本に書いて|本の中|第1巻|第一巻|もうひとつのわたし|みゆの話|読後/u);

  const asksQuote =
    hasAny(text, /引用|本文|原文|第\d+章|第[一二三四五六七八九十]+章|何章|どこに書いて|その箇所|該当箇所|本ではどう書いて/u);

  const asksConcept =
    hasAny(text, /イマジナル|創造の方向|怖い未来|Muverse|ミューバース|かがみ|鏡|自己受容/u) &&
    hasAny(text, /とは|意味|教えて|詳しく|説明|何ですか|なんですか|知りたい|どういう/u);

  if (appLinked) {
    return { mode: 'app_integration', reason: 'book_linked_app_context', referencesBook, asksQuote, asksConcept };
  }

  if (asksQuote) {
    return { mode: 'quote', reason: 'quote_requested', referencesBook, asksQuote, asksConcept };
  }

  if (asksConcept) {
    return { mode: 'concept_explain', reason: referencesBook ? 'book_concept_question' : 'concept_question', referencesBook, asksQuote, asksConcept };
  }

  if (referencesBook) {
    return { mode: 'book_reader', reason: 'book_reader_signal', referencesBook, asksQuote, asksConcept };
  }

  return { mode: 'background', reason: 'always_on_background', referencesBook, asksQuote, asksConcept };
}

function buildSeedText(args: {
  mode: MuCanonKnowledgeMode;
  quoteAllowed: boolean;
  mentionBookAllowed: boolean;
}): string {
  const { mode, quoteAllowed, mentionBookAllowed } = args;

  const lines = [
    'MU_CANON_KNOWLEDGE_V1 (DO NOT OUTPUT)',
    `mode=${mode}`,
    `quoteAllowed=${quoteAllowed ? 'true' : 'false'}`,
    `mentionBookAllowed=${mentionBookAllowed ? 'true' : 'false'}`,
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
    'rule=世界観は本文材料ではなく、見る姿勢として使う',
    'rule=必要な時だけ、日常語で「未来の景色」「守りたいもの」「小さく置く」と返す',
  ];

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
    mode === 'app_integration' ||
    (mode === 'concept_explain' && detected.referencesBook);

  return {
    enabled: true,
    version: 'MU_CANON_KNOWLEDGE_V1',
    mode,
    quoteAllowed,
    mentionBookAllowed,
    reason: detected.reason,
    concepts: ['imajinal', 'mu_mirror', 'creative_direction', 'muverse_field', 'self_acceptance_os'],
    seedText: buildSeedText({ mode, quoteAllowed, mentionBookAllowed }),
  };
}