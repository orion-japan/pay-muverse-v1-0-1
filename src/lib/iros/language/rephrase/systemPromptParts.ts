/* eslint-disable @typescript-eslint/no-explicit-any */

export type PromptQuestionType =
  | 'meaning'
  | 'structure'
  | 'intent'
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
    '前半で今回の核心が読めるようにする。',
    '状態説明ラベルではなく、相手に返す自然文で書く。',
    '聞かれていない方向へ飛ばない。',
    '会話として自然で、密度は落としすぎない。',
    '必要なときだけ一段深い意味を短く添える。',
    '最後は一行で自然に閉じる。',
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
