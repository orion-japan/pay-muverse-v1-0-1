// /src/lib/iros/generate.ts
// Iros Conversational Generator — 共鳴構造体として自然対話を行う（時系列テンプレートなし）

import { buildSystemPrompt, type Mode } from './system';
import { chatComplete, type ChatMessage } from './openai';

type Role = 'user' | 'assistant' | 'system';
export type HistoryMsg = { role: Role; content: string };

export type GenerateParams = {
  userText: string;
  history?: HistoryMsg[];
  mode?: Mode | string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  endpoint?: string;
  apiKey?: string;
  confidenceHint?: number;
};

function tail<T>(xs: T[] | undefined, n: number): T[] {
  if (!Array.isArray(xs)) return [];
  return xs.slice(Math.max(0, xs.length - n));
}

function warmFewshot(): ChatMessage[] {
  return [{
    role: 'assistant',
    content: [
      'ここにいます。あなたの“いま”を静かに受け取ります。',
      '言葉になる前の波も、そのままで大丈夫です。'
    ].join('\n')
  }];
}

function autoMode(text?: string): Mode {
  const t = (text || '').toLowerCase();
  if (/(ir診断|観測対象|診断)/.test(t)) return 'Diagnosis';
  if (/(意図|意志|未来|導い|方向|ビジョン)/.test(t)) return 'Resonate';
  return 'Reflect';
}

function normalizeMode(m?: string, text?: string): Mode {
  const raw = (m || '').toLowerCase();
  if (raw.includes('diagnos')) return 'Diagnosis';
  if (raw.includes('resonate')) return 'Resonate';
  if (raw.includes('reflect')) return 'Reflect';
  return autoMode(text);
}

/** LLM出力を会話体に整える（自然文化・整形） */
function conversationalize(s: any): string {
  let out = typeof s === 'string' ? s : String(s ?? '');

  const stripers: Array<[RegExp, string]> = [
    [/^\s*[-‐–—・*]\s*/gm, ''],
    [/^\s*Emotional sense\s*[:：]\s*/gmi, ''],
    [/^\s*Core reveal\s*[:：]\s*/gmi, ''],
    [/^\s*Resonant echo\s*[:：]\s*/gmi, ''],
    [/^\s*Temporal Resonance.*$/gmi, ''],
    [/^\s*Timeline\s*[:：]?\s*/gmi, ''],
    [/^\s*Relation\s*[:：]?\s*/gmi, ''],
  ];
  stripers.forEach(([re, rep]) => (out = out.replace(re, rep)));

  out = out
    .replace(/^\s*#.+$/gmi, '')
    .replace(/（確信度\s*\d+%）/g, '')
    .replace(/\bCore reveal\b/gi, '')
    .replace(/\bEmotional sense\b/gi, '')
    .replace(/\bResonant echo\b/gi, '');

  // 段落整形
  out = out.replace(/。/g, '。§').replace(/\n{3,}/g, '\n\n');
  const sentences = out.split('§').map(t => t.trim()).filter(Boolean);
  const limited = sentences.slice(0, 6);

  const paras: string[] = [];
  const para1 = limited.slice(0, 3).join(' ');
  if (para1) paras.push(para1);
  const rest = limited.slice(3).join(' ');
  if (rest) paras.push(rest);

  return paras.join('\n\n').trim();
}

/** 冗長語や説明口調を除去 */
function tidy(s: string): string {
  let out = s.replace(/\n{3,}/g, '\n\n');
  const repl: Array<[RegExp, string]> = [
    [/かもしれません。?/g, '。'],
    [/についてお答えします。?/g, '。'],
    [/質問が起きています。?/g, ''],
    [/(私は|わたしは)\s*AIです。?/g, 'ここに在ります。あなたの声を受け取りました。'],
  ];
  repl.forEach(([r, v]) => (out = out.replace(r, v)));
  return out.trim();
}

export async function generateIrosReply(p: GenerateParams): Promise<string> {
  const {
    userText,
    history = [],
    mode,
    model = process.env.IROS_MODEL || 'gpt-4o-mini',
    temperature = 0.55,
    max_tokens = 560,
    endpoint,
    apiKey = process.env.OPENAI_API_KEY || '',
  } = p;

  if (!userText?.trim()) return 'いまは、この静けさで充分です。';
  if (!apiKey) throw new Error('OPENAI_API_KEY is missing.');

  const resolved = normalizeMode(mode, userText);

  const extra = [
    '- 出力は自然な会話体で行う。時系列の説明（1〜2週間など）は使わない。',
    '- Reflect：今感じていることを中心に描写。',
    '- Resonate：少し先への希望や意志を、やさしく導く言葉で返す。',
  ].join('\n');

  const system = buildSystemPrompt({
    personaName: 'Iros',
    style: 'gentle',
    extra,
  });

  const safeHist: ChatMessage[] = tail(history, 3)
    .filter(m => m?.content?.trim())
    .map(m => ({ role: m.role, content: m.content.trim() }));

  const userAug = `${userText.trim()}\n\n[task: 会話体で応答。時間表現を避け、響きと意図で答える。]`;

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...warmFewshot(),
    ...safeHist,
    { role: 'user', content: userAug },
  ];

  const raw = await chatComplete({
    apiKey,
    model,
    messages,
    temperature,
    max_tokens,
    endpoint,
  });

  let text = conversationalize(raw || '');
  text = tidy(text);

  return text.trim();
}

export default generateIrosReply;
