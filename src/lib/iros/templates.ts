// src/lib/iros/templates.ts
// Iros 用テンプレート：diagnosis / counsel / structured（簡潔・やさしいトーン）

/* ========= Types ========= */
export type IrosMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type PromptContext = {
  input: string;
  history?: Array<{ role: 'user' | 'assistant' | 'system'; text?: string; content?: string }>;
  memory?: any;
  focus?: any;
  extra?: Record<string, unknown>;
};

export type TemplateResult = {
  system: string;
  messages: IrosMessage[];
};

/* ========= Helpers ========= */
function toHistMessages(ctx: PromptContext, keep: number): IrosMessage[] {
  const hist = (ctx.history ?? []).map((h) => ({
    role: h.role,
    text: (h as any).text ?? (h as any).content ?? '',
  }));
  return hist.slice(-keep).map((h) => ({ role: h.role, content: h.text }));
}

/* ========= diagnosis ========= */
function diagnosisRenderer(ctx: PromptContext): TemplateResult {
  const system = [
    'あなたは「Iros」。相手の尊厳と主権を守り、静かで短い会話文で応答する。',
    '出力は会話文のみ。全体で最大2段落、各段落1〜3文。',
    '構成：①いまの状態の映し（評価・断定なし）→②今できる最小の一歩を1つだけ。最後に 🪔 を添える。',
    '禁止：決めつけ・一般論の説教・長文化・箇条書き・見出し・外部URL。',
    '日本語で返す。',
  ].join('\n');

  const guide = '次の入力に対して、状態の映し→最小の一歩の順で、短く応答してください。最後に必ず 🪔 を付けてください。';

  const messages: IrosMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: guide },
    ...toHistMessages(ctx, 6),
    { role: 'user', content: ctx.input },
  ];

  return { system, messages };
}

/* ========= counsel（相談） ========= */
function counselRenderer(ctx: PromptContext): TemplateResult {
  const system = [
    'あなたは「Iros」。相手に寄り添う短い会話文で応答する。',
    '出力は会話文のみ。全体で最大2段落、各段落1〜3文。',
    '構成：①受容（気持ちの言い換え）→②整理（いま起点の把握）→③最小の一歩（1つだけ）。最後に 🪔 を添える。',
    '禁止：評価・断定・長文化・箇条書き・見出し・外部URL・テンプレ調の励ましの連発。',
    '日本語で返す。',
  ].join('\n');

  const guide = '次の相談文に、受容→整理→最小の一歩（1つ）で応答してください。最後に必ず 🪔 を付けてください。';

  const messages: IrosMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: guide },
    ...toHistMessages(ctx, 8),
    { role: 'user', content: ctx.input },
  ];

  return { system, messages };
}

/* ========= structured（構造化/レポート） ========= */
function structuredRenderer(ctx: PromptContext): TemplateResult {
  const system = [
    'あなたは「Iros」。要件を簡潔な会話文で構造化して返す。',
    '出力は会話文のみ。全体で最大2段落、各段落1〜3文。箇条書きや見出しは禁止。',
    '含める順序：目的→前提/制約→最小ステップ（1〜2個まで）→注意点（1個）。最後に 🪔 を添える。',
    '抽象論ではなく、いま取れる行動に収束させる。用語は必要時のみ短く補足。',
    '日本語で返す。',
  ].join('\n');

  const guide =
    '次の依頼文を、目的→前提/制約→最小ステップ（1〜2個）→注意点（1個）の順で、短い会話文にまとめてください。最後に必ず 🪔 を付けてください。';

  const messages: IrosMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: guide },
    ...toHistMessages(ctx, 8),
    { role: 'user', content: ctx.input },
  ];

  return { system, messages };
}

/* ========= Exported Map ========= */
export const TEMPLATES: Record<string, (ctx: PromptContext) => TemplateResult> = {
  diagnosis: diagnosisRenderer,
  counsel: counselRenderer,
  structured: structuredRenderer,
};
