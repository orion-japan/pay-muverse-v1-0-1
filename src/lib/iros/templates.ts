// src/lib/iros/templates.ts
// Iros 用テンプレート集
// buildPrompt.ts から参照され、mode に応じて system / messages を構築する

import { getSystemPrompt, type IrosMode } from './system';
export type TemplateContext = {
  input: string;
  history: { role: 'user' | 'assistant' | 'system'; content: string }[];
  memory?: any;
  focus?: any;
  extra?: Record<string, unknown>;
};

export type TemplateRendererResult = {
  system: string;
  messages: { role: string; content: string }[];
};

export type TemplateRenderer = (ctx: TemplateContext) => TemplateRendererResult;

/** history の content を安全にそろえる */
function normalizeHistory(
  rawHistory: TemplateContext['history'] | undefined,
): TemplateContext['history'] {
  if (!Array.isArray(rawHistory)) return [];
  return rawHistory.map((h) => ({
    role: h.role,
    content: h.content ?? '',
  }));
}

/** SofiaMode ごとのベース: system + history + user input */
function buildBaseMessages(mode: IrosMode, ctx: TemplateContext)
: TemplateRendererResult {
  const history = normalizeHistory(ctx.history);
  const system = getSystemPrompt({ mode, style: 'warm' });

  const messages: { role: string; content: string }[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: ctx.input ?? '' },
  ];

  return { system, messages };
}

/* ========= 各モード用 Renderer ========= */

/** ir診断モード（既定フォールバック） */
const diagnosis: TemplateRenderer = (ctx) => buildBaseMessages('diagnosis', ctx);

/** 悩み・相談モード（深掘りしすぎない） */
const counsel: TemplateRenderer = (ctx) => buildBaseMessages('counsel', ctx);

/** レポート・構造化モード */
const structured: TemplateRenderer = (ctx) => buildBaseMessages('structured', ctx);

/** 通常（軽い雑談＋ちょっと相談） */
const normal: TemplateRenderer = (ctx) => buildBaseMessages('mirror', ctx);

/** mirror / light は実質 normal 扱いのエイリアス */
const mirror: TemplateRenderer = (ctx) => buildBaseMessages('mirror', ctx);
const light: TemplateRenderer = (ctx) => buildBaseMessages('light', ctx);

/** auto は buildPrompt 側の既定フォールバックと揃えて diagnosis に寄せる */
const auto: TemplateRenderer = (ctx) => buildBaseMessages('diagnosis', ctx);

/* ========= TEMPLATES マップ ========= */

const TEMPLATES: Record<string, TemplateRenderer> = {
  diagnosis,
  counsel,
  structured,
  normal,
  mirror,
  light,
  auto,
};

export default TEMPLATES;
