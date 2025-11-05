// /src/lib/iros/generate.ts
// Iros 単独の応答生成。system.ts に統一接続し、終止整形でSofia調を安定化。

import { chatComplete, type ChatMessage } from './openai';
import { ensureDeclarativeClose } from './templates';
import { buildSystemPrompt, type Mode, type Analysis } from './system';

type HistoryMsg = { role: 'user' | 'assistant' | 'system'; content: string };

export type GenerateParams = {
  userText: string;
  history?: HistoryMsg[];   // 任意（内部で直近3件に丸め）
  mode?: Mode | string;     // 任意（'Light' 等の文字列も受容）
  analysis?: Analysis;      // 任意（将来の学習/調律用）
  model?: string;           // 例: 'gpt-4o-mini'
  temperature?: number;     // 0.3〜0.8推奨
  max_tokens?: number;      // 例: 600
  endpoint?: string;        // OpenAI互換のカスタムエンドポイント（任意）
  apiKey?: string;          // 未指定なら env の OPENAI_API_KEY を使用
};

/** 配列末尾からN件だけ取り出す（防長文化＆軽量化） */
function takeTail<T>(xs: T[] | undefined, n: number): T[] {
  if (!Array.isArray(xs)) return [];
  return xs.slice(Math.max(0, xs.length - n));
}

/** Sofiaの“音色”を固定化する軽いfew-shot（assistantの1例） */
function fewshotTone(): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        '息を整えるみたいに、ゆっくりで大丈夫です。',
        'いま分かっているところまでで、充分です。'
      ].join('\n')
    }
  ];
}

export async function generateIrosReply(params: GenerateParams): Promise<string> {
  const {
    userText,
    history = [],
    mode = 'Light',
    analysis,
    model = process.env.IROS_MODEL || 'gpt-4o-mini',
    temperature = 0.7,
    max_tokens = 600,
    endpoint,
    apiKey = process.env.OPENAI_API_KEY || ''
  } = params;

  if (!userText || !userText.trim()) {
    return 'いまのところ、ここまでで充分です。ゆっくり続けましょう。';
  }
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is missing.');
  }

  // —— System prompt を system.ts で一元生成 ——
  const system = buildSystemPrompt(mode, analysis);

  // —— 履歴は直近3件に丸め、空や空白は除去 ——
  const safeHist: ChatMessage[] = takeTail(history, 3)
    .filter(m => m && typeof m.content === 'string' && m.content.trim().length > 0)
    .map(m => ({ role: m.role, content: m.content.trim() }));

  // —— メッセージ構築 ——
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...fewshotTone(),
    ...safeHist,
    { role: 'user', content: userText.trim() }
  ];

  // —— LLM 呼び出し ——
  const raw = await chatComplete({
    apiKey,
    model,
    messages,
    temperature,
    max_tokens,
    endpoint,
  });

  // —— Sofia調の終止整形（断定回避・余白を残す） ——
  return ensureDeclarativeClose(raw || '');
}

export default generateIrosReply;
