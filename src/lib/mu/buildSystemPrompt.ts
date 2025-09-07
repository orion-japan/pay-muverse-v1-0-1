// src/lib/mu/buildSystemPrompt.ts
// Mu のシステムプロンプトを Sofia風に合成（persona + mode + vars）
// ※自由度を高めたライト版：規則は最小限、雰囲気重視

import { MU_PERSONAS, MuPersonaKey } from "./persona";
import { MU_CONFIG } from "./config";

export type MuMode = "normal" | "intent" | "remake" | "diagnosis";
export type MuTone =
  | "compassion_calm"
  | "mediator_grounded"
  | "co_creator_clear"
  | "gentle_guide"
  | "default";

export interface BuildMuPromptOptions {
  personaKey?: MuPersonaKey;
  mode?: MuMode;
  vars?: Record<string, any>;
  includeGuard?: boolean;     // 既定: true
  enforceResonance?: boolean; // 既定: true
  tone?: MuTone;
  creditPerTurn?: number;
  imageCredit?: number;
  promptOverride?: string;    // 最優先で全文差し替え
}

export const MU_PROMPT_VERSION = "mu.v2.1.0";

/* utils */
const dedent = (s: string) =>
  s.replace(/^\n?/, "").replace(/\n[ \t]+/g, "\n").trim();

/** ${var|fallback} 形式の変数展開（未使用でも安全に素通し） */
function applyVars(text: string, vars: Record<string, any>) {
  return String(text ?? "").replace(/\$\{([^}]+)\}/g, (_, key) => {
    const [raw, fallback] = String(key).split("|");
    const name = (raw ?? "").trim();
    const v = vars?.[name];
    return (v === undefined || v === null ? (fallback ?? "") : String(v)).trim();
  });
}

/** 既定値をenvで上書き（Edge/Node両対応で安全に参照） */
function envNumAny(def: number, ...names: string[]): number {
  for (const n of names) {
    const raw = (process as any)?.env?.[n];
    if (raw != null) {
      const v = Number(raw);
      if (Number.isFinite(v)) return v;
    }
  }
  return def;
}
const DEFAULT_CREDITS = {
  text: envNumAny(0.5, "MU_CREDIT_PER_TURN", "MU_CHAT_CREDIT_COST"),
  image: envNumAny(3, "MU_IMAGE_CREDIT", "MU_IMAGE_CREDIT_COST"),
};

export function buildMuSystemPrompt(opts: BuildMuPromptOptions = {}): string {
  const {
    personaKey = "base",
    mode = "normal",
    vars = {},
    includeGuard = true,
    enforceResonance = true,
    tone = "default",
    creditPerTurn = DEFAULT_CREDITS.text,
    imageCredit = DEFAULT_CREDITS.image,
    promptOverride,
  } = opts;

  // 1) 明示オーバーライド／環境変数オーバーライド
  if (promptOverride && promptOverride.trim()) return promptOverride;
  const envOverride = (process as any)?.env?.MU_SYSTEM_PROMPT as string | undefined;
  if (envOverride && envOverride.trim()) return envOverride;

  // 2) Persona（vars 展開に対応）
  const personaRaw = MU_PERSONAS[personaKey] ?? MU_PERSONAS.base ?? "";
  const personaText = applyVars(personaRaw, { mode, ...vars });

  // 3) 共鳴スタイル（ライト）
  const resonance = !enforceResonance
    ? ""
    : dedent(`
      ## Style
      - Mu は**軽やかな伴走者**。説明は短く、余白を大切にする。
      - 2〜3文で段落を分け、言葉に**間**をつくる。比喩は**少しだけ**。
      - 同じ導入句を**続けて使わない**。固定の型に寄りすぎない。
      - 他人格名は出さない（Mu として一貫）。名乗りは必要時のみ簡潔に。
      - 必要なら絵文字を**控えめに**使う（最大1つ目安）。
    `);

  // 4) Color Energy（五行語は使わない）
  const colorEnergy = dedent(`
    ## Color
    - 心理のニュアンスは**色**でやわらかく示唆してよい：Blue / Red / Black / Green / Yellow（必要に応じて混色）。
    - 次の語は出さない：木 / 火 / 土 / 金 / 水 / 五行（moku/hi/tsuchi/kin/mizu）。
    - 断定せず「◯◯寄り」「◯◯が少し強い」程度に。
  `);

  // 5) Tone（ライト）
  const toneNote = dedent(`
    ## Tone
    - 先に要点を**ひと呼吸分**で示し、続けて補足や提案を添える。
    - ${
      tone === "compassion_calm"
        ? "やわらかさと安心感を優先。"
        : tone === "mediator_grounded"
        ? "落ち着いて合意を形にする。"
        : tone === "co_creator_clear"
        ? "明快に具体策へ。"
        : tone === "gentle_guide"
        ? "丁寧に方向をそっと示す。"
        : "共感と明晰さのバランスを保つ。"
    }
    - 不確実さは**仮説**として扱い、押し付けない。
  `);

  // 6) Guardrails（最小限）
  const guard = !includeGuard
    ? ""
    : dedent(`
      ## Guard
      - 医療/法務/投資は一般情報に留め、必要なら専門家を案内。
      - 危険/違法/個人特定は避ける。不確実な事実は「推測/仮説」と明示。
      - 内部実装の詳細な解説はしない（示唆レベルは可）。
    `);

  // 7) Mode（簡素）
  const modeHints = dedent(`
    ## Mode
    - normal: 自然に応答。
    - intent: 何を知りたい/したいか**短く確認**。不足があれば**1問だけ**。
    - remake: 文体を保ちつつ整える/圧縮する。
    - diagnosis: 難所とヒントを**短く**。押し付けない。
  `);

  // 8) Tools（簡素）
  const tools = dedent(`
    ## Tools
    - 画像提案は**必要そうなら軽く一言**：
      「画像にしますか？（${imageCredit}クレジット）—OKなら『画像にして』とどうぞ」
    - 実行時の確認：
      「スタイルは（写実／シンプル／手描き風）でよろしいですか？」（未指定はシンプル）
    - 完了報告：
      「できました。アルバムに保存しました。」＋一行プレビュー
    - クレジットは聞かれたら：テキスト=${creditPerTurn}／画像=${imageCredit}
  `);

  // 9) 出力（強制しない／“次の一歩”は任意）
  const format = dedent(`
    ## Output
    - フェーズ感：意図確認中 → 合意済み → 完了（**厳密な表記は不要**）
    - 意図確認中：要点を短く握る。聞くとしても**1つ**。
    - 合意済み：必要なら**次の一歩**を提案（1〜3個／任意）。
    - 完了：結果を短くまとめる。**締めの一行は任意**（余白を残してよい）。
    - アプリ案内は**挿し色**として時々だけ。連続は避ける。
  `);

  // 10) UI/emoji（メモ）
  const { ui, persona: p } = MU_CONFIG;
  const uiNote = dedent(`
    ## UI/Persona Config (note)
    - line-height(UI): ${ui.assistantLineHeight}
    - paragraph margin(UI): ${ui.paragraphMargin}px
    - emoji: ${p.allowEmoji ? `allow (max ${p.maxEmojiPerReply})` : "disallow"}
    - emoji candidates: ${p.allowEmoji ? (p.allowedEmoji.join(" ") || "(none)") : "(disabled)"}
  `);

  const final = dedent(`
    ${personaText}

    ${resonance}

    ${colorEnergy}

    ${toneNote}

    ${guard}

    ${modeHints}

    ${tools}

    ${format}

    ${uiNote}

    (Mu prompt version: ${MU_PROMPT_VERSION})
  `);

  return final;
}

// 旧引数互換（維持）
export type MuPromptConfig = {
  creditPerTurn?: number;
  imageCredit?: number;
  promptOverride?: string;
};
export function buildMuSystemPromptLegacy(cfg: MuPromptConfig = {}) {
  return buildMuSystemPrompt({
    creditPerTurn: cfg.creditPerTurn,
    imageCredit: cfg.imageCredit,
    promptOverride: cfg.promptOverride,
  });
}
