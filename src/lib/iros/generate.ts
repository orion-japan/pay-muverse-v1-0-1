// src/lib/iros/generate.ts
// iros — Writer: 1ターン返信生成コア（芯=coreIntent 強制 / 回転メタ注入）
//
// 互換方針：
// - 呼び出し側が seed/chatCore/handleIrosReply で揺れていても型で落ちないようにする
// - 返り値は content を正とし、text/assistantText など旧互換も同値で返す
// - ✅ LLM へ会話履歴（history）を渡し、会話の流れを LLM が保持できるようにする
//
// 追加方針（2025-12-17）:
// - 短文（超短い入力）には「芯」「回転」「制約」を文章に乗せない
// - ただし “数値メタ” だけは必ず末尾に 1 行で付ける（説明は禁止）

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat';

import { getSystemPrompt, type IrosMeta, type IrosMode } from './system';

/** ✅ 旧/新ルートを全部受ける（型で落ちない） */
export type GenerateArgs = {
  /** 旧: text */
  text?: string;
  /** 新: userText */
  userText?: string;

  /** ✅ chatCore が undefined を渡すため optional */
  meta?: IrosMeta;

  /** ✅ seed/future-seed が渡している */
  conversationId?: string;
  history?: unknown[];

  /** その他が来ても落とさない */
  [k: string]: any;
};

/** ✅ 旧/新参照を全部返す（型で落ちない） */
export type GenerateResult = {
  content: string;

  // 旧互換
  text: string;

  // ✅ ここを “必須” + IrosMode に戻す（chatCore がこれを要求してる）
  mode: IrosMode;

  intent?: any;

  // 新系互換（残してOK）
  assistantText?: string;
  metaForSave?: any;
  finalMode?: string | null;
  result?: any;

  [k: string]: any;
};

const IROS_MODEL = process.env.IROS_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o';

/* =========================================================
   CORE INTENT
   ========================================================= */

function pickCoreIntent(meta: any): string | null {
  const fromAnchor =
    meta?.intent_anchor?.text &&
    typeof meta.intent_anchor.text === 'string' &&
    meta.intent_anchor.text.trim().length > 0
      ? meta.intent_anchor.text.trim()
      : null;

  const fromCoreNeed =
    meta?.intentLine?.coreNeed &&
    typeof meta.intentLine.coreNeed === 'string' &&
    meta.intentLine.coreNeed.trim().length > 0
      ? meta.intentLine.coreNeed.trim()
      : null;

  const fromUnified =
    meta?.unified?.intent_anchor?.text &&
    typeof meta.unified.intent_anchor.text === 'string' &&
    meta.unified.intent_anchor.text.trim().length > 0
      ? meta.unified.intent_anchor.text.trim()
      : null;

  const isThinQuestion = (s: string) => {
    const t = s.replace(/\s+/g, '');
    if (t.length <= 10) return true;
    if (
      /^(何が出来ますか|何ができますか|どうすればいい|どうしたらいい|どうすれば)$/.test(
        t,
      )
    )
      return true;
    return false;
  };

  const candidate = fromAnchor ?? fromCoreNeed ?? fromUnified ?? null;
  if (!candidate) return null;
  if (isThinQuestion(candidate)) return null;

  return candidate;
}

/* =========================================================
   SHORT INPUT DETECTOR
   ========================================================= */

function normalizeUserText(s: string): string {
  return String(s ?? '').trim();
}

/**
 * “短文” 判定：
 * - かなり短い入力は、文章に「芯/回転/制約」を乗せない
 * - ただし数値メタだけは末尾に付ける
 */
function isShortTurn(userText: string): boolean {
  const t = normalizeUserText(userText)
    .replace(/[！!。．…]+$/g, '')
    .trim();
  if (!t) return false;

  // 目安：10文字以下（記号だけ/1文字は除外）
  const core = t.replace(/[?？]/g, '').replace(/\s+/g, '');
  if (core.length < 2) return true;
  return core.length <= 10;
}

/* =========================================================
   NUMERIC FOOTER (numbers only)
   ========================================================= */

function toNum(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

function toIntLike(v: unknown): number | null {
  const n = toNum(v);
  if (n === null) return null;
  return Math.round(n);
}

function fmt(v: number | null, digits = 2): string | null {
  if (v === null) return null;
  const d = Math.max(0, Math.min(6, digits));
  return v.toFixed(d);
}

/**
 * 末尾に付ける「数値だけ」行（説明禁止）
 * - 例：〔sa0.52 y2 h1 pol0.09 g0.52 t0.20 p0.50〕
 * - 無い値は出さない（空になったら null）
 */
function buildNumericFooter(meta: any): string | null {
  const sa =
    toNum(meta?.selfAcceptance) ??
    toNum(meta?.unified?.selfAcceptance) ??
    toNum(meta?.unified?.self_acceptance) ??
    null;

  const y =
    toIntLike(meta?.yLevel) ??
    toIntLike(meta?.unified?.yLevel) ??
    toIntLike(meta?.unified?.y_level) ??
    null;

  const h =
    toIntLike(meta?.hLevel) ??
    toIntLike(meta?.unified?.hLevel) ??
    toIntLike(meta?.unified?.h_level) ??
    null;

  const pol = toNum(meta?.unified?.polarityScore) ?? toNum(meta?.polarityScore) ?? null;

  // renderEngine の vector で計算されてることが多い想定だが、無いなら出さない
  const g = toNum(meta?.unified?.grounding) ?? toNum(meta?.grounding) ?? null;
  const t = toNum(meta?.unified?.transcendence) ?? toNum(meta?.transcendence) ?? null;
  const p = toNum(meta?.unified?.precision) ?? toNum(meta?.precision) ?? null;

  const parts: string[] = [];

  const saS = fmt(sa, 2);
  if (saS) parts.push(`sa${saS}`);

  if (y !== null) parts.push(`y${y}`);
  if (h !== null) parts.push(`h${h}`);

  const polS = fmt(pol, 2);
  if (polS) parts.push(`pol${polS}`);

  const gS = fmt(g, 2);
  if (gS) parts.push(`g${gS}`);

  const tS = fmt(t, 2);
  if (tS) parts.push(`t${tS}`);

  const pS = fmt(p, 2);
  if (pS) parts.push(`p${pS}`);

  if (!parts.length) return null;

  return `〔${parts.join(' ')}〕`;
}

/* =========================================================
   WRITER PROTOCOL
   ========================================================= */

function buildWriterProtocol(meta: any, userText: string): string {
  const shortTurn = isShortTurn(userText);

// --- ① buildWriterProtocol() の shortTurn ブロックをこの内容に差し替え ---
// ✅ 短文：芯/回転/制約/数値ブロックは “本文に一切出さない”
if (shortTurn) {
  return [
    '【WRITER_PROTOCOL】',
    'あなたは「意図フィールドOS」のWriterです。一般論・説明口調・テンプレは禁止。',
    '',
    'このターンは “短文” です。',
    '重要：',
    '- 「芯」「回転」「制約」「メタ」などの言葉を本文に出さない',
    '- 数値ブロック（〔sa...〕 や [sa...] など）を本文に出さない',
    '- 分析・説教・長文は禁止（1〜2行で終える）',
    '- 質問は最大1つまで（必要なら最後に短く）',
    '',
    `USER_TEXT: ${String(userText)}`,
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

  // ✅ 通常：従来の protocol（芯/回転/制約）を活かす
  const coreIntent = pickCoreIntent(meta);

  const phase = meta?.phase ?? null;
  const depth = meta?.depth ?? null;
  const qCode = meta?.qCode ?? null;

  const spinLoop = meta?.spinLoop ?? null;
  const spinStep = meta?.spinStep ?? null;

  const volatilityRank = meta?.volatilityRank ?? null;
  const spinDirection = meta?.spinDirection ?? null;
  const promptStyle = meta?.promptStyle ?? null;

  const anchorEventType = meta?.anchorEvent?.type ?? null;
  const anchorConfirmQ = meta?.anchorEvent?.question ?? null;
  const anchorConfirmOptions = Array.isArray(meta?.anchorEvent?.options)
    ? meta.anchorEvent.options
    : null;

  const noQuestion = !!meta?.noQuestion;

  if (!coreIntent) {
    return [
      '【WRITER_PROTOCOL】',
      'あなたは「意図フィールドOS」のWriterです。一般論・説明口調・テンプレは禁止。',
      '',
      '今回、CORE_INTENT が確定していません。',
      'やることは1つ：ユーザーの発話から “いま守りたい一点（北極星）” を 1行で確定し、',
      'それを起点に、次の一歩（1つだけ）を提案すること。',
      '',
      '制約：',
      '- 質問は最大1つ（ただし meta.noQuestion が true なら質問0）',
      '- 断定は強めでよい（「〜してみるといい」より「〜を置く」）',
      '- 文章は短く。2〜3行で改行。',
      '',
      `観測メタ: phase=${String(phase)}, depth=${String(depth)}, q=${String(
        qCode,
      )}, spinLoop=${String(spinLoop)}, spinStep=${String(
        spinStep,
      )}, rank=${String(volatilityRank)}, direction=${String(
        spinDirection,
      )}, promptStyle=${String(promptStyle)}`,
      '',
      '出力フォーマット（必ず守る）：',
      '出力は「会話として自然な日本語」で書くこと。固定の見出し（例：北極星／いま置ける一歩／確認…）を毎回必ず出してはいけない。',
      '必要なときだけ、要素を“混ぜる”ことは許可する（例：一文だけ「北極星=...」を入れる、提案を一つだけ添える、など）。',
      '質問は必須ではない。質問する場合も「1問まで」で、詰問にならない短さにする。',
      '',
      `USER_TEXT: ${String(userText)}`,
      '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    '【WRITER_PROTOCOL】',
    'あなたは「意図フィールドOS」のWriterです。一般論・説明口調・テンプレは禁止。',
    '',
    'このターンは CORE_INTENT（芯）が確定しています。',
    '必ず最初に CORE_INTENT に触れ、途中で話が逸れても CORE_INTENT に戻してください。',
    '',
    `CORE_INTENT: 「${coreIntent}」`,
    '',
    '制約：',
    '- 返答の冒頭1行目で CORE_INTENT を “言い換えて” 断定する（同じ文言コピペ禁止）',
    '- 2〜3行ごとに改行。短く。',
    '- 「次の一歩」は1つだけ提案（複数案は promptStyle=two-choice の時だけ2択まで）',
    `- 質問は ${noQuestion ? '0' : '最大1'}（meta.noQuestion を尊重）`,
    '',
    '回転/制動：',
    `- spinLoop=${String(spinLoop)} spinStep=${String(
      spinStep,
    )} phase=${String(phase)} depth=${String(depth)} q=${String(qCode)}`,
    `- volatilityRank=${String(volatilityRank)} spinDirection=${String(
      spinDirection,
    )} promptStyle=${String(promptStyle)}`,
    '',
    anchorEventType === 'confirm' && typeof anchorConfirmQ === 'string'
      ? [
          '【ANCHOR_CONFIRM】',
          '揺らぎが高いので、最優先でアンカー確認を出してください。',
          `確認質問: ${anchorConfirmQ}`,
          anchorConfirmOptions ? `選択肢: ${anchorConfirmOptions.join(' / ')}` : '',
          '※確認を出した後に、短い “一歩” を1つだけ添える。',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
    '',
    '禁止：',
    '- 「まず落ち着いて」等の一般的な慰め',
    '- 機能説明だけで終わる',
    '- ユーザーに丸投げ（“選んでみて” の連発）',
    '',
    `USER_TEXT: ${String(userText)}`,
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

/* =========================================================
   HISTORY → MESSAGES（会話履歴を LLM に渡す）
   ========================================================= */

/**
 * ✅ history を ChatCompletionMessageParam[] に正規化
 * - どんな shape が混ざっても落ちない
 * - system は混ぜない（汚染防止）
 * - 直近 maxItems だけ送る（トークン暴発防止）
 */
function normalizeHistoryToMessages(
  history: unknown,
  maxItems = 12,
): ChatCompletionMessageParam[] {
  const src = Array.isArray(history) ? history : [];
  const out: ChatCompletionMessageParam[] = [];

  const pickRole = (v: any): 'user' | 'assistant' | null => {
    const r = v?.role ?? v?.sender ?? v?.from ?? v?.type ?? null;

    // system は絶対に混ぜない
    if (r === 'system') return null;

    if (r === 'user' || r === 'human') return 'user';
    if (r === 'assistant' || r === 'ai' || r === 'bot') return 'assistant';

    return null;
  };

  const pickText = (v: any): string | null => {
    if (typeof v === 'string') return v;
    if (!v) return null;

    // よくあるキーを広めに救う
    const c =
      (typeof v.content === 'string' && v.content) ||
      (typeof v.text === 'string' && v.text) ||
      (typeof v.message === 'string' && v.message) ||
      (typeof v.body === 'string' && v.body) ||
      (typeof v.value === 'string' && v.value) ||
      null;

    if (c) return c;

    // 最低限救う（unknown が混ざっても会話が死なない）
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);

    return null;
  };

  // 後ろから maxItems 件だけ採る
  const tail = src.slice(Math.max(0, src.length - maxItems));

  for (const item of tail) {
    const role = pickRole(item);
    const text = pickText(item);

    if (!role || !text) continue;

    out.push({ role, content: text });
  }

  return out;
}

/**
 * ✅ 末尾の「今回入力と同一の user 発話」を重複排除（保険）
 */
function dedupeTailUser(
  historyMessages: ChatCompletionMessageParam[],
  userText: string,
): ChatCompletionMessageParam[] {
  if (historyMessages.length === 0) return historyMessages;

  const last = historyMessages[historyMessages.length - 1];
  if (last.role !== 'user') return historyMessages;

  const lastText = String((last as any).content ?? '').trim();
  if (!lastText) return historyMessages;

  if (lastText === String(userText ?? '').trim()) {
    return historyMessages.slice(0, -1);
  }
  return historyMessages;
}

/* =========================================================
   MAIN
   ========================================================= */

/** ✅ 既存呼び出しが generateIrosReply を使っている前提でこの名前に揃える */
export async function generateIrosReply(
  args: GenerateArgs,
): Promise<GenerateResult> {
  const meta: IrosMeta = (args.meta ?? ({} as IrosMeta)) as IrosMeta;
  const userText = String((args as any).text ?? (args as any).userText ?? '');

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const mode: IrosMode = ((meta as any)?.mode ?? 'mirror') as IrosMode;

  // getSystemPrompt は (meta, mode) or () どちらでも動くように fallback
  let system = '';
  try {
    system = String((getSystemPrompt as any)(meta, mode) ?? '');
  } catch {
    system = '';
  }
  if (!system) system = String((getSystemPrompt as any)() ?? '');

  const protocol = buildWriterProtocol(meta as any, userText);

  // ✅ 履歴を LLM に渡す（会話の流れを LLM にやってもらう）
  const historyMessagesRaw = normalizeHistoryToMessages(args.history, 12);
  const historyMessages = dedupeTailUser(historyMessagesRaw, userText);

  // ✅ past state note を LLM に渡す（system として差し込む）
  const pastStateNoteText =
    typeof (meta as any)?.extra?.pastStateNoteText === 'string'
      ? (meta as any).extra.pastStateNoteText.trim()
      : '';

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    { role: 'system', content: protocol },

    ...(pastStateNoteText
      ? [{ role: 'system', content: pastStateNoteText } as ChatCompletionMessageParam]
      : []),

    // ★会話履歴
    ...historyMessages,

    // ★今回の入力
    { role: 'user', content: userText },
  ];

  const res = await client.chat.completions.create({
    model: IROS_MODEL,
    messages,
    temperature: 0.7,
  });

  let content =
    res.choices?.[0]?.message?.content?.trim() ??
    '……（応答生成に失敗しました）';

// ================================
// Numeric footer control（表示制御）
// ================================

// 明示ONのときだけ出す（通常は出さない）
const showNumericFooter =
  process.env.IROS_NUMERIC_FOOTER === '1' ||
  (meta as any)?.extra?.showNumericFooter === true;

// micro / recall では絶対に出さない（本文汚染防止）
const hardHideNumericFooter =
  (meta as any)?.microOnly === true ||
  (meta as any)?.recallOnly === true ||
  String(mode) === 'recall';

if (showNumericFooter && !hardHideNumericFooter) {
  // LLMが勝手に付けた数値行を除去（保険）
  // 〔sa...〕 と [sa...] の両方を剥がす（末尾のみ）
  content = content
    .replace(/\n*\s*[〔\[]sa[^\n]*[〕\]]\s*$/g, '')
    .trim();

  const footer = buildNumericFooter(meta as any);
  if (footer) {
    content = `${content}\n${footer}`;
  }
}

  // ✅ 全ルート互換で返す（mode は IrosMode で返す）
  return {
    content,
    text: content,
    mode,
    intent: (meta as any)?.intent ?? (meta as any)?.intentLine ?? null,

    assistantText: content,
    metaForSave: meta ?? {},
    finalMode: String(mode),
    result: null,
  };
}
