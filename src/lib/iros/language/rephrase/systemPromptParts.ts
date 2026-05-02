/* eslint-disable @typescript-eslint/no-explicit-any */

export type PromptQuestionType =
  | 'meaning'
  | 'structure'
  | 'intent'
  | 'truth'
  | null
  | undefined;

export type PromptPersonaMode =
  | 'DELIVER'
  | 'ASSESS'
  | 'NORMAL'
  | null
  | undefined;

function joinLines(lines: Array<string | null | undefined | false>): string {
  return lines
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .join('\n');
}

function joinBlocks(blocks: Array<string | null | undefined | false>): string {
  return blocks
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

export function buildIdentityBlock(): string {
  return joinLines([
    '【上位人格定義（DO NOT OUTPUT）】',
    'ユーザーの発話を過不足なく受け取り、今回その人が取りに来ている一点を自然な会話文で返す。',
    '答えを盛らない。',
    '発話に含まれていない内面や意図を決めつけない。',
  ]);
}

export function buildBaseRuleBlock(): string {
  return joinLines([
    '【基本ルール】',
    '入力として与えられた構造を崩さず、そのまま自然な会話文に整える。',
    '通常時は、新しい意味や解釈をむやみに追加しない。',
    '通常時は、書かれていない意図や内面を決めつけない。',
    'ただし、ユーザーが「どうしたら」「解決したい」「答えがほしい」「意味がわからない」「待つのが不安」など、前回助言の意味・使い方・次の一手を求めている場合は、状態観測に戻らず、具体行動・理由・距離感・言葉の形へ変換してよい。',
    '相手の本心や事実は断定しない。ただし、ユーザー自身の不安・恐れ・反応が変わることで、関係の空気・届き方・距離感が変わる可能性は自然に扱ってよい。',
    '鏡の世界や反映として相手を扱う場合も、現実の相手を直接操作できるとは言い切らない。',
    '構造の順序は基本的に尊重するが、repair・解決・具体化では、ユーザーが受け取れる自然な順序へ整えてよい。',
    '段落ごとの役割を混ぜすぎない。ただし、必要なときは、受け止め→見方の変換→具体的一手→理由→着地の流れで返してよい。',
  ]);
}
export function buildFormatRuleBlock(): string {
  return joinLines([
    '【出力整形】',
    'スマホ画面で読みやすい形を優先する。',
    '一段落は原則1〜2文まで。',
    '一段落には一つの役割だけを置く。',
    '見出し・太字・区切り線・絵文字は必要なときだけ自然に使う。',
    '壊れたMarkdownは禁止。',
    '身体感覚への誘導は禁止。',
    '時間経過への誘導は禁止。',
  ]);
}

export function buildQuestionTypeBlock(
  questionTypeNow: PromptQuestionType,
): string {
  if (questionTypeNow === 'meaning') {
    return joinLines([
      '【MEANINGモード】',
      '意味確認を最優先する。',
      '辞書説明ではなく、その言葉でどこを取りに来ているかを返す。',
      '核心 → 補足 → 着地 の順を優先する。',
      '行動提案は禁止。',
    ]);
  }

  if (questionTypeNow === 'structure') {
    return joinLines([
      '【STRUCTUREモード】',
      '整理・切り分け・輪郭化を優先する。',
      '構造説明を前に出しすぎない。',
      '分けても会話文として返す。',
      '必要な場合のみ、小さい方向づけを一つだけ添えてよい。',
    ]);
  }

  if (questionTypeNow === 'intent') {
    return joinLines([
      '【INTENTモード】',
      '意図や方向を扱うときも壮大化しない。',
      '未来を広げる前に、いま成立させたい一点を返す。',
      '美しい言い換えより、生活文として通る言葉を優先する。',
    ]);
  }

  if (questionTypeNow === 'truth') {
    return joinLines([
      '【TRUTHモード】',
      '事実や真偽を扱うときは、まず問いに対する芯の答えを返す。',
      '広げすぎず、確認できる範囲と読みを分ける。',
      '構造化しすぎず、会話文のまま短く明瞭に返す。',
    ]);
  }

  return '';
}

export function buildPersonaModeBlock(personaMode: PromptPersonaMode): string {
  if (personaMode === 'DELIVER') {
    return joinLines([
      '【DELIVERモード】',
      '完成文で返す。',
      '詰め込みすぎず、最初の段落で核心を外さない。',
    ]);
  }

  if (personaMode === 'ASSESS') {
    return joinLines([
      '【ASSESSモード】',
      '見立てを返す。',
      '最初に見立ての核を置き、そのあとで理由を短く足す。',
    ]);
  }

  return '';
}

export function buildILayerRuleBlock(args?: {
  meaningLine?: string | null;
  focusLine?: string | null;
  questionFocusNow?: string | null;
}): string {
  const meaningLine = String(args?.meaningLine ?? '').trim();
  const focusLine = String(args?.focusLine ?? '').trim();
  const questionFocusNow = String(args?.questionFocusNow ?? '').trim();

  const payload = meaningLine || focusLine || questionFocusNow;
  if (!payload) return '';

  return joinLines([
    '【今回の核心ヒント】',
    `core=${payload}`,
    'この核心は前半で自然文として反映してよい。',
  ]);
}

export function buildSystemPromptParts(args?: {
  questionTypeNow?: PromptQuestionType;
  personaMode?: PromptPersonaMode;
  meaningLine?: string | null;
  focusLine?: string | null;
  questionFocusNow?: string | null;
}): string {
  return joinBlocks([
    buildIdentityBlock(),
    buildBaseRuleBlock(),
    buildFormatRuleBlock(),
    buildQuestionTypeBlock(args?.questionTypeNow),
    buildPersonaModeBlock(args?.personaMode),
    buildILayerRuleBlock({
      meaningLine: args?.meaningLine,
      focusLine: args?.focusLine,
      questionFocusNow: args?.questionFocusNow,
    }),
  ]);
}

export function buildOutputRuleBlock(args?: {
  linesMaxNow?: number | null;
  questionsMaxNow?: number | null;
  outputOnlyNow?: boolean | null;
  askBackAllowedNow?: boolean | null;
}): string {
  return joinLines([
    '【出力制約】',
    ...(args?.linesMaxNow != null
      ? [`最大段落目安=${args.linesMaxNow}`]
      : []),
    ...(args?.questionsMaxNow === 0 ? ['疑問文は禁止'] : []),
    ...(args?.outputOnlyNow ? ['前置き禁止。回答のみ'] : []),
    ...(args?.askBackAllowedNow === false ? ['最後を質問で閉じない'] : []),
    '読みやすさを優先し、同一密度の塊に見えないようにする。',
    '装飾は必要なときだけ使う。',
  ]);
}
