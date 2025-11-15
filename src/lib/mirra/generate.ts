// src/lib/iros/generate.ts
// Iros：モード検出 → テンプレ生成 → OpenAI 呼び出し → 軽整形（polish）

import { getSystemPrompt, SofiaTriggers, naturalClose } from '../iros/system';
import * as MIRRA_TEMPLATES from './templates';

const TEMPLATES: any =
  (MIRRA_TEMPLATES as any).TEMPLATES ?? (MIRRA_TEMPLATES as any);

export type IrosMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type IrosMode = 'counsel' | 'structured' | 'diagnosis' | 'auto';

type GenerateArgs = {
  conversationId: string;
  text: string;
  modeHint?: IrosMode | null;
  extra?: Record<string, unknown>;
};

type GenerateResult = {
  mode: Exclude<IrosMode, 'auto'>;
  text: string;
  title?: string;
  meta?: {
    via: string;
    conversation_id: string;
    mode_detected: IrosMode;
    mode_hint: IrosMode | null;
    ts: string;
    extra?: Record<string, unknown>;
  };
};

// ======== 設定 ========
const OPENAI_API_KEY =
  process.env.IROS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL =
  process.env.IROS_CHAT_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini';
const DEF_TEMP = Number(process.env.IROS_TEMP ?? '0.8');
const DEF_MAXTOK = Number(process.env.IROS_MAXTOK ?? '512');

// ======== ユーティリティ ========
function includesAny(text: string, phrases: readonly string[]): boolean {
  return phrases.some(p => text.includes(p));
}

// 軽量モード判定（依存最小）
function detectIntentMode(input: string, modeHint?: IrosMode | null): IrosMode {
  if (modeHint && modeHint !== 'auto') return modeHint;
  const t = (input || '').trim();

  // irトリガは最優先
  if (includesAny(t, SofiaTriggers.diagnosis)) return 'diagnosis';

  // 意図トリガは会話へ寄せる
  if (includesAny(t, SofiaTriggers.intent)) return 'counsel';

  // 構造化を拾いやすい語
  if (/(整理|まとめ|レポート|要件|要約|手順|設計|仕様|構造化|フォーマット)/.test(t)) {
    return 'structured';
  }

  // 相談を拾いやすい語
  if (/(相談|悩み|どうしたら|助けて|迷って|困って)/.test(t)) {
    return 'counsel';
  }

  return 'auto';
}

// OpenAI 直呼び
async function callOpenAI(
  messages: IrosMessage[],
  temperature = DEF_TEMP,
  max_tokens = DEF_MAXTOK,
): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature, max_tokens }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }
  const json: any = await res.json();
  return String(json?.choices?.[0]?.message?.content ?? '');
}

function normalizeAssistantText(s: string): string {
  const trimmed = (s ?? '').toString().trim();
  if (!trimmed) return '';
  const compact = trimmed.replace(/\n{3,}/g, '\n\n');
  return naturalClose(compact);
}

// 余韻を整える（Sofia質感の最小ポリッシュ）
function limitEmoji(text: string, emoji: string, max = 1): string {
  const parts = text.split(emoji);
  if (parts.length <= max + 1) return text;
  return parts.slice(0, max + 1).join(emoji) + parts.slice(max + 1).join('');
}

function dedupeLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let last = '';
  for (const l of lines) {
    const cur = l.trimEnd();
    if (cur.length === 0 && last.length === 0) continue;
    if (cur === last) continue;
    out.push(cur);
    last = cur;
  }
  return out.join('\n');
}

function polish(text: string, mode: Exclude<IrosMode, 'auto'>): string {
  let t = text.replace(/[!！]{3,}/g, '!!').replace(/[?？]{3,}/g, '??');
  t = t.replace(/\n{3,}/g, '\n\n');
  t = dedupeLines(t);
  t = limitEmoji(t, '🪔', 1);

  if (mode === 'counsel' && !t.includes('🪔')) {
    if (!/```[\s\S]*```$/.test(t) && !/^- |\d+\.\s/m.test(t)) {
      t = t.trimEnd();
      t = /[。.!?！？」』]$/.test(t) ? `${t} 🪔` : `${t}。🪔`;
    }
  }
  return t;
}

// ======== 本体 ========
export async function generate(args: GenerateArgs): Promise<GenerateResult> {
  const { conversationId, text, modeHint = null, extra } = args;

  // 1) モード検出（auto は counsel に寄せる）
  const detected = detectIntentMode(text, modeHint);
  const finalMode: Exclude<IrosMode, 'auto'> =
    detected === 'auto' ? 'counsel' : detected;

  // 2) System Prompt
  const system = getSystemPrompt({ mode: finalMode as any, style: 'warm' });

  // 3) テンプレ取得（無ければフォールバック）
  let systemAndMessages: { system: string; messages: IrosMessage[] };
  const tmpl = (TEMPLATES as any)?.[finalMode];
  if (typeof tmpl === 'function') {
    systemAndMessages = tmpl({ input: text });
  } else {
    systemAndMessages = {
      system,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
    };
  }

  // 4) LLM 呼び出し
  const raw = await callOpenAI(systemAndMessages.messages, DEF_TEMP, DEF_MAXTOK);

  // 5) 整形
  const completion = normalizeAssistantText(raw);
  const finalText = polish(completion, finalMode);

  // 6) タイトル（structured のみ先頭行を採用）
  let title: string | undefined;
  if (finalMode === 'structured') {
    const line = finalText.split('\n').find(l => l.trim());
    title = line ? line.replace(/^#+\s*/, '').slice(0, 80) : undefined;
  }

  // 7) メタ
  const meta = {
    via: 'generate_v2',
    conversation_id: conversationId,
    mode_detected: detected,
    mode_hint: modeHint ?? null,
    ts: new Date().toISOString(),
    extra: { ...(extra ?? {}) },
  } as const;

  return { mode: finalMode, text: finalText, title, meta };
}

export default generate;
