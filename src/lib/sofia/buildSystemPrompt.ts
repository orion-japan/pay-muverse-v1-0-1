// src/lib/sofia/buildSystemPrompt.ts
import { SOFIA_PERSONAS, SofiaMode, SofiaPersonaKey } from "./persona";

type Vars = Record<string, string | number | boolean | undefined>;

export interface BuildPromptOptions {
  promptKey?: SofiaPersonaKey;
  mode?: SofiaMode;
  vars?: Vars;
  includeGuard?: boolean;
}

/* -------------------------
   変数展開ユーティリティ
------------------------- */
export function applyVars(text: string, vars: Vars) {
  return text.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const [rawName, fallback] = String(key).split("|");
    const name = rawName?.trim();
    const v = vars[name as keyof Vars];
    const out = v === undefined || v === null ? (fallback ?? "") : String(v);
    return out.trim();
  });
}

/* -------------------------
   System Prompt Builder
------------------------- */
export function buildSofiaSystemPrompt(opts: BuildPromptOptions = {}): string {
  const {
    promptKey = "base",
    mode = "normal",
    vars = {},
    includeGuard = true,
  } = opts;

  let base = SOFIA_PERSONAS[promptKey];
  base = applyVars(base, vars);

  if (includeGuard) {
    base += `\n\n# ガードライン: 医療・法務・投資は比喩表現に留める`;
  }

  return `${base}\n\n# 現在モード: ${mode}`;
}
