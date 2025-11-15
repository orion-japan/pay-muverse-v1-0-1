// src/lib/iros/buildPrompt.ts
// mode に応じて templates を選び、LLM へ渡す system/messages を構築

import TEMPLATES from './templates';

// TemplateResult をゆるくして型崩壊を防ぐ
export type TemplateResult = {
  system: string;
  messages: Array<{ role: string; content: string }>;
} | any;

export type BuildArgs = {
  mode: string; // 'counsel' | 'structured' | 'diagnosis' | 'auto' など
  text: string;
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content?: string; text?: string }>;
  memory?: any;
  focus?: any;
  extra?: Record<string, unknown>;
};

export default async function buildPrompt(
  args: BuildArgs,
): Promise<TemplateResult> {
  const { mode, text, history, memory, focus, extra } = args;

  // 履歴の正規化（text/content どちらでも受ける）
  const normHistory =
    (history ?? []).map((h) => ({
      role: h.role,
      content: (h as any).content ?? (h as any).text ?? '',
    })) || [];

  // auto → 既定テンプレ（diagnosis）にフォールバック
  const pick = (m: string) => {
    if (TEMPLATES[m]) return TEMPLATES[m];
    return TEMPLATES['diagnosis'];
  };

  const renderer = pick(String(mode || 'diagnosis'));
  const result = renderer({
    input: text,
    history: normHistory,
    memory,
    focus,
    extra,
  });

  // 万一テンプレ返却が欠落しても落とさない
  const safeSystem =
    result?.system ?? 'あなたは「Iros」。静かに丁寧に短く返答してください。';

  const safeMessages =
    Array.isArray(result?.messages) && result.messages.length
      ? result!.messages
      : [
          { role: 'system', content: safeSystem },
          { role: 'user', content: text ?? '' },
        ];

  return { system: safeSystem, messages: safeMessages } as TemplateResult;
}
