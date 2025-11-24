// src/lib/iros/generate.ts
// Iros 1ターン返信生成コア
// - 本文生成 + I層（意図レイヤー）解析を同時に行う
// - intent.layer は I1 / I2 / I3（意図層）または null

import OpenAI from 'openai';
import {
  getSystemPrompt,
  type IrosMeta,
  type IrosMode,
  type Depth,          // 将来の拡張用に残しておく（S/R/C/I 全体の深度）
  type IrosIntentMeta, // I層メタ情報（layer / reason / confidence）
} from './system';

const IROS_MODEL =
  process.env.IROS_MODEL ??
  process.env.OPENAI_MODEL ??
  'gpt-4o';

console.log('[IROS_MODEL-check]', {
  IROS_MODEL_env: process.env.IROS_MODEL,
  OPENAI_MODEL_env: process.env.OPENAI_MODEL,
  resolved:
    process.env.IROS_MODEL ??
    process.env.OPENAI_MODEL ??
    'gpt-4o',
});

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export type GenerateArgs = {
  conversationId?: string;
  text: string;
  meta?: IrosMeta;
};

export type GenerateResult = {
  content: string;      // Iros 本文
  text: string;         // 旧 chatCore 互換用（= content と同じ）
  mode: IrosMode;       // 実際に使っているモード（meta.mode が無ければ mirror）
  intent?: IrosIntentMeta | null; // I層ジャッジ結果
};

/**
 * Iros 応答を 1ターン生成する。
 * - system.ts の IROS_SYSTEM + meta を使って system プロンプトを組み立てる
 * - 本文生成と別に、userテキストから I層（I1〜I3）を判定する
 */
export async function generateIrosReply(
  args: GenerateArgs,
): Promise<GenerateResult> {
  const { text, meta } = args;

  const system = getSystemPrompt(meta);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ];

  // ① 本文生成
  const res = await client.chat.completions.create({
    model: IROS_MODEL,
    messages,
    temperature: 0.7,
  });

  const content =
    res.choices[0]?.message?.content?.toString().trim() ?? '';

  const mode: IrosMode = meta?.mode ?? 'mirror';

  // ② I層解析（ユーザー入力ベース）
  const intent = await analyzeIntentLayer(text);

  return {
    content,
    text: content,
    mode,
    intent,
  };
}

/* =========================================================
   I層アナライザー
   - userText から I1 / I2 / I3 を判定（なければ null）
   - reason / confidence も付与
   - ここでは「意図層に触れているかどうか」だけを見る
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

  const messages: OpenAI.ChatCompletionMessageParam[] = [
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
      parsed && typeof parsed.layer === 'string'
        ? parsed.layer
        : null;

    // ★ ここを Depth ではなく I1/I2/I3 専用の union にする
    const layer: 'I1' | 'I2' | 'I3' | null =
      layerRaw === 'I1' || layerRaw === 'I2' || layerRaw === 'I3'
        ? (layerRaw as 'I1' | 'I2' | 'I3')
        : null;

    const reason =
      parsed && typeof parsed.reason === 'string'
        ? parsed.reason
        : null;

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
 * - 素直に JSON ならそのまま parse
 * - それ以外なら、最初の { 〜 最後の } を抜き出して再トライ
 */
function safeParseJson(text: string): any | null {
  if (!text) return null;

  const trimmed = text.trim();

  // 素直な JSON の場合
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fallthrough
    }
  }

  // 何か説明 + JSON の場合を想定して { ... } 部分だけ抜き出す
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
