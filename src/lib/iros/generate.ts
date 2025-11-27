// src/lib/iros/generate.ts
// Iros 1ターン返信生成コア
// - 本文生成 + I層（意図レイヤー）解析を同時に行う
// - intent.layer は I1 / I2 / I3（意図層）または null

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat';

import {
  getSystemPrompt,
  type IrosMeta,
  type IrosMode,
  type Depth, // 将来の拡張用（S/R/C/I/T 全体の深度）
  type IrosIntentMeta, // I層メタ情報（layer / reason / confidence）
} from './system';
import type { IntentLineAnalysis } from './intent/intentLineEngine';

const IROS_MODEL =
  process.env.IROS_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o';

console.log('[IROS_MODEL-check]', {
  IROS_MODEL_env: process.env.IROS_MODEL,
  OPENAI_MODEL_env: process.env.OPENAI_MODEL,
  resolved: process.env.IROS_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o',
});

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/** 過去履歴 1件ぶん（LLM に渡す用） */
export type HistoryItem = {
  role: 'user' | 'assistant';
  content: string;
};

export type GenerateArgs = {
  conversationId?: string;
  text: string;
  meta?: IrosMeta;

  /** 過去の会話履歴（古い → 新しい順） */
  history?: HistoryItem[];
};

export type GenerateResult = {
  content: string; // Iros 本文（ユーザーに見せるテキスト）
  text: string; // 旧 chatCore 互換用（= content と同じ）
  mode: IrosMode; // 実際に使っているモード（meta.mode が無ければ mirror）
  intent?: IrosIntentMeta | null; // I層ジャッジ結果
};

/* =========================================================
   数値メタのみを渡す内部メモ
   - SA / yLevel / hLevel / depth / qCode / mode / intentLine（主要フィールド）
   - テンプレ文章やトーン指示は一切含めない
========================================================= */

function buildNumericMetaNote(meta?: IrosMeta | null): string | null {
  if (!meta) return null;

  const payload: any = {};

  // 数値系
  const sa =
    typeof (meta as any)?.selfAcceptance === 'number'
      ? ((meta as any).selfAcceptance as number)
      : null;
  if (sa != null && !Number.isNaN(sa)) {
    payload.selfAcceptance = sa;
  }

  const yLevel =
    typeof (meta as any)?.yLevel === 'number'
      ? ((meta as any).yLevel as number)
      : null;
  if (yLevel != null && !Number.isNaN(yLevel)) {
    payload.yLevel = yLevel;
  }

  const hLevel =
    typeof (meta as any)?.hLevel === 'number'
      ? ((meta as any).hLevel as number)
      : null;
  if (hLevel != null && !Number.isNaN(hLevel)) {
    payload.hLevel = hLevel;
  }

  // コード系
  if (typeof meta.depth === 'string') {
    payload.depth = meta.depth;
  }

  if (typeof (meta as any)?.qCode === 'string') {
    payload.qCode = (meta as any).qCode as string;
  }

  if (typeof meta.mode === 'string') {
    payload.mode = meta.mode;
  }

  // IntentLineAnalysis は構造だけ（説明文はそのまま載せるが、ここでスタイル指示はしない）
  const intentLine = (meta as any)?.intentLine as
    | IntentLineAnalysis
    | null
    | undefined;
  if (intentLine) {
    payload.intentLine = {
      nowLabel: intentLine.nowLabel ?? null,
      coreNeed: intentLine.coreNeed ?? null,
      intentBand: intentLine.intentBand ?? null,
      direction: intentLine.direction ?? null,
      focusLayer: intentLine.focusLayer ?? null,
      riskHint: intentLine.riskHint ?? null,
      guidanceHint: intentLine.guidanceHint ?? null,
    };
  }

  if (Object.keys(payload).length === 0) return null;

  // IROS_SYSTEM 側で SA = SelfAcceptance などの意味はすでに説明されている前提
  // ここでは「生の状態値」としてだけ渡す
  return `【IROS_STATE_META】${JSON.stringify(payload)}`;
}

/* =========================================================
   トーン補正（かもしれません → 言い切り寄せ）
   ※ generate.ts 内ローカル版
========================================================= */
function strengthenIrosTone(text: string): string {
  if (!text) return text;

  let result = text;

  // 0) 変な二重表現・崩れた表現を先に正規化
  result = result.replace(/かも\s*しれません/g, 'かもしれません'); // 「かも しれません」を一本化
  result = result.replace(/かもかもしれません/g, 'かもしれません'); // 二重「かも」を潰す
  result = result.replace(/と言えますしれません/g, 'と言えるでしょう'); // 既存バグの救済

  // 1) 「かもしれません(ね)」をカウントし、2回目以降だけ言い切り化
  let count = 0;
  result = result.replace(/かもしれません(ね)?/g, (match) => {
    count += 1;
    if (count === 1) {
      // 1回目はそのまま残す
      return match;
    }
    // 2回目以降は言い切り寄せ
    return 'と言えます';
  });

  // 2) 単独の「かも」はいじらない（誤爆を避ける）

  // 3) 単語レベルの弱い語尾を軽く補正
  result = result
    .replace(/ように思います/g, 'と感じられます')
    .replace(/ようにも見えます/g, 'と見なせます');

  return result;
}

/* =========================================================
   本体：Iros 応答 1ターン生成
   ★ ユーザーに返すのは「本文のみ」
========================================================= */

export async function generateIrosReply(
  args: GenerateArgs,
): Promise<GenerateResult> {
  const { text, meta, history } = args;

  // ベースの IROS_SYSTEM
  let system = getSystemPrompt(meta);

  // 数値メタ（状態値のみ）を追記（※ system メッセージにだけ載る）
  const numericMetaNote = buildNumericMetaNote(meta);
  if (numericMetaNote && numericMetaNote.trim().length > 0) {
    system = `${system}\n\n${numericMetaNote}`;
  }

  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: system,
    },
    ...buildHistoryMessages(history),
    {
      role: 'user',
      content: text,
    },
  ];

  // ① 本文生成
  const res = await client.chat.completions.create({
    model: IROS_MODEL,
    messages,
    temperature: 0.7,
  });

  const rawContent = res.choices[0]?.message?.content?.toString().trim() ?? '';

  // SA に応じて「かもしれません」を言い切り寄せ
  const saValue =
    typeof (meta as any)?.selfAcceptance === 'number'
      ? ((meta as any).selfAcceptance as number)
      : null;

  let content = rawContent;

  // selfAcceptance が十分あるときだけトーン補正をかける
  // lowゾーン（< 0.3）は、あえて「かもしれません」を残しておく
  if (saValue == null || saValue >= 0.3) {
    content = strengthenIrosTone(content);
  }

  const currentMode: IrosMode = meta?.mode ?? 'mirror';
  const mode: IrosMode = currentMode ?? 'mirror';

  // ② I層解析（ユーザー入力ベース）
  const intent = await analyzeIntentLayer(text);

  // ③ 余計なヘッダーは一切付けず、そのまま本文のみ返す
  const finalContent = content;

  return {
    content: finalContent,
    text: finalContent,
    mode,
    intent,
  };
}

/* =========================================================
   履歴メッセージの整形
========================================================= */

const MAX_HISTORY_ITEMS = 20;

function buildHistoryMessages(
  history?: HistoryItem[],
): ChatCompletionMessageParam[] {
  if (!history || !Array.isArray(history) || history.length === 0) {
    return [];
  }

  const sliced = history.slice(-MAX_HISTORY_ITEMS);

  return sliced
    .map((h): ChatCompletionMessageParam | null => {
      if (!h || typeof h.content !== 'string') return null;

      const trimmed = h.content.trim();
      if (!trimmed) return null;

      const role: 'assistant' | 'user' =
        h.role === 'assistant' ? 'assistant' : 'user';

      return {
        role,
        content: trimmed,
      };
    })
    .filter((m): m is ChatCompletionMessageParam => m !== null);
}

/* =========================================================
   I層アナライザー
========================================================= */

async function analyzeIntentLayer(userText: string): Promise<IrosIntentMeta> {
  const trimmed = (userText || '').trim();
  if (!trimmed) {
    return {
      layer: null,
      reason: null,
      confidence: null,
    };
  }

  const systemPrompt = [
    'あなたは「Iros」のための I層（意図レイヤー）アナライザーです。',
    'ユーザーの発言が、どの程度「意図・存在・生きる意味」に踏み込んでいるかを判定します。',
    '',
    '出力は必ず次の JSON 形式 1行のみで返してください（日本語で説明しないこと）。',
    '',
    '{',
    '  "layer": "I1" | "I2" | "I3" | null,',
    '  "reason": "なぜそのレイヤーと判定したかの短い日本語説明",',
    '  "confidence": 0〜1 の数値（だいたいの確信度）',
    '}',
    '',
    '◎ 判定ルール（簡易）',
    '- I3: 「なぜ生きているのか」「存在理由」「生まれてきた意味」など、人生全体・存在そのものに踏み込んでいる。',
    '- I2: 「どう生きたいか」「本当の願い」「人生の方向性」など、人生レベルの選択や本心を扱っている。',
    '- I1: 「自分らしくありたい」「本当の自分」「在り方」など、在り方レベルで意図に触れているが、人生全体までは踏み込んでいない。',
    '- null: 上記のいずれにも明確には当てはまらない。',
    '',
    '※ 迷う場合は、より浅いレイヤー（I1寄り）を選び、どう迷ったかを reason に書いてください。',
  ].join('\n');

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: trimmed },
  ];

  try {
    const res = await client.chat.completions.create({
      model: IROS_MODEL,
      messages,
      temperature: 0,
    });

    const raw = res.choices[0]?.message?.content ?? '';
    const text = typeof raw === 'string' ? raw.trim() : String(raw).trim();

    const parsed = safeParseJson(text);

    const layerRaw =
      parsed && typeof parsed.layer === 'string' ? parsed.layer : null;

    const layer: 'I1' | 'I2' | 'I3' | null =
      layerRaw === 'I1' || layerRaw === 'I2' || layerRaw === 'I3'
        ? (layerRaw as 'I1' | 'I2' | 'I3')
        : null;

    const reason =
      parsed && typeof parsed.reason === 'string' ? parsed.reason : null;

    let confidence: number | null = null;
    if (parsed && typeof parsed.confidence === 'number') {
      confidence = parsed.confidence;
    } else if (parsed && typeof parsed.confidence === 'string') {
      const n = Number(parsed.confidence);
      confidence = Number.isFinite(n) ? n : null;
    }

    return {
      layer,
      reason,
      confidence,
    };
  } catch (e) {
    console.warn('[IROS/Intent] analyzeIntentLayer error', e);
    return {
      layer: null,
      reason: null,
      confidence: null,
    };
  }
}

/**
 * LLMの出力から JSON を安全に取り出すヘルパー。
 */
function safeParseJson(text: string): any | null {
  if (!text) return null;

  const trimmed = text.trim();

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fallthrough
    }
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = trimmed.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }

  return null;
}
