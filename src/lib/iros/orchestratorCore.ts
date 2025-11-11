// src/lib/iros/orchestratorCore.ts
// Iros — Orchestrator Core（低レベル依存の集約 / intentは別ファイルへ分離）
// - detectMode は ./intent を使用（本ファイル内の重複定義を撤去）
// - callLLM / phrasing / title / focus の最小結線
// - wire.orchestrator.ts から呼ばれる

import { chatComplete, type ChatMessage } from '@/lib/llm/chatComplete';
import phrasing from './phrasing';
import { makeTitle } from './title';
import { analyzeFocus } from './focusCore';
import detectIntentMode from './intent';

export type IrosMode = 'diagnosis' | 'auto' | 'counsel' | 'structured';

export type IrosFocusMeta = {
  phase?: string;
  depth?: string;
  q?: string;
  reasons?: string[];
} | null;

export type IrosMemorySnapshot = {
  summary?: string;
  keywords?: string[];
} | null;

export type IrosDeps = {
  debug?: boolean;
  model?: string;
};

export type RunInput = {
  mode?: IrosMode;
  text: string;
  history?: ChatMessage[];
  memory?: IrosMemorySnapshot;
  extra?: Record<string, unknown>;
};

export type RunOutput = {
  reply: string;
  meta: {
    focus?: IrosFocusMeta;
    memory?: IrosMemorySnapshot;
    timings?: Record<string, number>;
    tokens?: { prompt?: number; completion?: number; total?: number } | null;
  };
};

/** ---- mode detection（intent.ts に集約） ---- */
export async function detectMode(text: string): Promise<IrosMode> {
  const dm: any = await (detectIntentMode as any)({ text });
  const m = dm?.mode ?? 'auto';
  // intent.ts は 'diagnosis' | 'counsel' | 'structured' | 'auto'
  // 本Coreは 'auto' を 'auto' のまま扱う
  return m as unknown as IrosMode;
}

/** ---- call LLM ---- */
export async function callLLM(
  model: string,
  messages: ChatMessage[],
  opts?: { temperature?: number; max_tokens?: number },
): Promise<string> {
  const result = await chatComplete({
    model,
    messages,
    temperature: opts?.temperature ?? 0.4,
    max_tokens: opts?.max_tokens ?? 640,
  });
  return phrasing.naturalClose(result ?? '');
}

/** ---- main run ---- */
export async function runCore(args: RunInput, deps?: IrosDeps): Promise<RunOutput> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};

  // detect mode
  const mode = args.mode || detectMode(args.text);

  // analyze focus
  const f0 = Date.now();
  const focus = analyzeFocus(args.text);
  timings.focus_ms = Date.now() - f0;

  // build messages（systemは上位のbuildPromptで付与する設計のためここではhistory+userのみ）
  const history = Array.isArray(args.history) ? args.history : [];
  const messages: ChatMessage[] = [
    ...(history ?? []),
    { role: 'user', content: args.text },
  ];

  // call LLM
  const c0 = Date.now();
  const reply = await callLLM(deps?.model || process.env.IROS_MODEL || 'gpt-4o-mini', messages);
  timings.llm_ms = Date.now() - c0;

  // post process
  const p0 = Date.now();
  const closed = phrasing.naturalClose(reply);
  const title = makeTitle(args.text, focus ?? undefined, args.memory ?? undefined);
  void title; // 現段ではログ用途。必要なら返却拡張
  timings.post_ms = Date.now() - p0;

  timings.total_ms = Date.now() - t0;

  return {
    reply: closed,
    meta: {
      focus,
      memory: args.memory ?? null,
      timings,
      tokens: null,
    },
  };
}

export default {
  detectMode,
  callLLM,
  runCore,
};
