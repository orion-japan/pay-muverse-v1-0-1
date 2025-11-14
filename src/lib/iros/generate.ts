// src/lib/iros/generate.ts
// 目的：Irosの1発話生成（モード自動判定 / 温度・トークン調整 / 応答整形）
// 依存：system.ts（getSystemPrompt, SofiaTriggers, naturalClose）/ templates.ts（TEMPLATES）
// 外部依存：なし（OpenAI REST直呼び）

import { TEMPLATES, type IrosMessage } from './templates';
import { getSystemPrompt, SofiaTriggers, naturalClose } from './system';

export type IrosMode = 'counsel' | 'structured' | 'diagnosis' | 'auto';

type GenerateArgs = {
  conversationId: string;
  text: string;
  modeHint?: IrosMode | null;
  extra?: Record<string, unknown>;
};

type GenerateResult = {
  mode: Exclude<IrosMode, 'auto'> | 'auto';
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

/* ===== 環境変数 ===== */
function env(key: string): string | undefined {
  try {
    return process.env?.[key];
  } catch {
    return undefined;
  }
}

const OPENAI_API_KEY =
  env('IROS_OPENAI_API_KEY') ||
  env('OPENAI_API_KEY') ||
  '';

const OPENAI_MODEL =
  env('IROS_CHAT_MODEL') ||
  env('OPENAI_MODEL') ||
  'gpt-4o-mini';

const DEF_TEMP = Number(env('IROS_TEMP') ?? '0.8');       // ← 改善提案どおり
const DEF_MAXTOK = Number(env('IROS_MAXTOK') ?? '512');   // ← 改善提案どおり

/* ===== ユーティリティ ===== */
function normalizeAssistantText(s: string): string {
  // 句読点終端の最低限対処 + 連続改行の整理
  const trimmed = (s ?? '').toString().trim();
  if (!trimmed) return '';
  const compact = trimmed.replace(/\n{3,}/g, '\n\n');
  return naturalClose(compact);
}

function includesAny(text: string, phrases: readonly string[]): boolean {
  return phrases.some(p => text.includes(p));
}

/* ===== モード自動判定（SofiaTriggers を利用） ===== */
function detectIntentMode(input: string, modeHint?: IrosMode | null): IrosMode {
  if (modeHint && modeHint !== 'auto') return modeHint;

  const t = (input || '').trim();

  // 明示トリガ（診断）
  if (includesAny(t, SofiaTriggers.diagnosis)) return 'diagnosis';

  // 明示トリガ（意図）は“意図トリガーモード”のレンダリング扱いだが、
  // generate では会話モードとしては counsel を選び、下流テンプレで扱う想定。
  if (includesAny(t, SofiaTriggers.intent)) return 'counsel';

  // キーワードでの簡易判定
  if (/(整理|まとめ|レポート|要件|手順|設計|仕様)/.test(t)) return 'structured';
  if (/(相談|悩み|どうしたら|助けて|迷って)/.test(t)) return 'counsel';

  return 'auto';
}

/* ===== OpenAI REST 直呼び（依存排除） ===== */
async function callOpenAI(messages: IrosMessage[], temperature = DEF_TEMP, max_tokens = DEF_MAXTOK): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature,
      max_tokens,
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const json: any = await res.json();
  const content = json?.choices?.[0]?.message?.content ?? '';
  return String(content ?? '');
}

/* ===== メイン ===== */
export async function generate(args: GenerateArgs): Promise<GenerateResult> {
  const { conversationId, text, modeHint = null, extra } = args;

  // 1) モード自動判定
  const detectedMode = detectIntentMode(text, modeHint);

  // 2) 実モード確定（auto → counsel 既定）
  const finalMode: Exclude<IrosMode, 'auto'> =
  detectedMode === 'auto' ? 'counsel' : detectedMode;

  // 3) System Prompt をモードに応じて取得
  const system = getSystemPrompt({
       mode: finalMode as any,
       style: 'warm',
     });

  // 4) テンプレに基づき messages を構築
  const tmpl = TEMPLATES[finalMode];
  const tpl = tmpl
    ? tmpl({ input: text })
    : {
        system,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ] as IrosMessage[],
      };

  // 5) LLM 呼び出し
  const raw = await callOpenAI(
       tpl.messages,   // ← templates 側はすでに role: 'system' を先頭に含む
      DEF_TEMP,
      DEF_MAXTOK,
     );

  // 6) 応答整形
  const completion = normalizeAssistantText(raw);

  // 7) タイトル（structuredのみ簡易抽出）
  let title: string | undefined;
  if (finalMode === 'structured') {
    const line = completion.split('\n').find(l => l.trim());
    title = line ? line.replace(/^#+\s*/, '').slice(0, 80) : undefined;
  }

  // 8) メタ
  const meta = {
    via: 'generate_v2',
    conversation_id: conversationId,
    mode_detected: detectedMode,
    mode_hint: modeHint ?? null,
    ts: new Date().toISOString(),
    extra: { ...(extra ?? {}) },
  } as const;

  return {
    mode: finalMode,
    text: completion,
    title,
    meta,
  };
}

export default generate;
