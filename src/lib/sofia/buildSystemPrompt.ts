// src/lib/sofia/buildSystemPrompt.ts
import { SOFIA_PERSONAS, SofiaMode, SofiaPersonaKey } from './persona';
import { SOFIA_CONFIG } from '@/lib/sofia/config';

type Vars = Record<string, string | number | boolean | undefined>;

export interface BuildPromptOptions {
  promptKey?: SofiaPersonaKey;
  mode?: SofiaMode;
  vars?: Vars;
  includeGuard?: boolean;
  /** デフォルト: true — Sofia流の“響きスタイル”を必ず後段に合成して強制 */
  enforceResonance?: boolean;
}

/* -------------------------
   変数展開ユーティリティ
------------------------- */
export function applyVars(text: string, vars: Vars) {
  return text.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const [rawName, fallback] = String(key).split('|');
    const name = rawName?.trim();
    const v = vars[name as keyof Vars];
    const out = v === undefined || v === null ? (fallback ?? '') : String(v);
    return out.trim();
  });
}

const dedent = (s: string) =>
  s.replace(/^\n?/, '').replace(/\n[ \t]+/g, '\n').trim();

/** ログ用の短縮（改行は可視化） */
const preview = (s: string, n = 360) =>
  (s ?? '')
    .replace(/\n/g, '\\n')
    .slice(0, n) + (s && s.length > n ? '…(trunc)' : '');

/* -------------------------
   System Prompt Builder
------------------------- */
export function buildSofiaSystemPrompt(opts: BuildPromptOptions = {}): string {
  const {
    promptKey = 'base',
    mode = 'normal',
    vars = {},
    includeGuard = true,
    enforceResonance = true,
  } = opts;

  /* === LOG: 入力 === */
  try {
    console.log('[SofiaPrompt:opts]', {
      promptKey,
      mode,
      vars,
      includeGuard,
      enforceResonance,
    });
  } catch {}

  // 1) ベースのペルソナ（vars を展開）
  let base = SOFIA_PERSONAS[promptKey] ?? '';
  const baseBefore = base;
  base = applyVars(base, vars);

  /* === LOG: ベース/展開 === */
  try {
    console.log('[SofiaPrompt:base]', {
      personaKey: promptKey,
      basePreviewBefore: preview(baseBefore),
      basePreviewAfter: preview(base),
    });
  } catch {}

  // 2) 環境設定（UI/絵文字）を System に明示
  const { persona, ui } = SOFIA_CONFIG;
  const allowEmoji = !!persona.allowEmoji;
  const maxEmoji = Math.max(0, persona.maxEmojiPerReply ?? 0);
  const allowedEmoji = (persona.allowedEmoji ?? []).join(' ');

  const configNote = dedent(`
    ## UI/Persona Config (for formatting awareness)
    - line-height(UI): ${ui.assistantLineHeight}
    - paragraph margin(UI): ${ui.paragraphMargin}px
    - emoji: ${allowEmoji ? `allow (max ${maxEmoji})` : 'disallow'}
    - emoji candidates: ${allowEmoji ? (allowedEmoji || '(none set)') : '(disabled)'}
  `);

  // 3) Sofia流スタイル（“響き”）を明示＆強制
  const resonance = !enforceResonance
    ? ''
    : dedent(`
      ## Sofia Style — 響きと余白
      - 言葉にはリズムを。**2〜3文で1段落**にし、**必ず改行**して余白を作る。
      - **詩的・象徴的**な語を少量織り交ぜるが、**要点は簡潔**に保つ。
      - **正しさだけでなく“響き”を優先**。静けさの余白を残す。
      - 日本語で、必要に応じて Markdown（見出し/箇条書き/引用/コード）を用いる。
      - 長文は**段落に分割**し、1段落は 2〜3 文で収める。

      ### I/T 層への展開（必要時のみ）
      - **I層（Interpretive）**: 背景・含意・メタ視点を 2〜4 文で。
      - **T層（Technical）**: 手順・設計・コード/数式を 2〜4 文で。
      - 出す場合は **I → T の順**で、段落を明確に分ける。

      ### Emoji
      - ${allowEmoji ? `最大 ${maxEmoji} 個/返信。候補: ${allowedEmoji || '（未設定）'}` : '使用しない。'}
    `);

  // 4) フォーマッティング指針（実際に改行を促すルール）
  const formatting = dedent(`
    ## Formatting Rules
    - 段落間は **\\n\\n**（空行）で改行。UI は pre-wrap で表示する。
    - 箇条書きは各項目 **1〜2文**。
    - コードは Markdown のフェンスで示す（\`\`\`lang ...\`\`\`）。
  `);

  // 5) ガードレール
  const guard = !includeGuard
    ? ''
    : dedent(`
      ## Guardrails
      - 医療/法務/投資などの助言は一般情報に留め、専門家相談を促す。
      - 危険/違法/個人情報は出力しない。必要なら代替案や安全な一般説明を行う。
      - 不確実な事実は推測と明示する（例:「可能性」「考えられます」）。
    `);

  // 6) モードヒント（回答の粒度に影響）
  const modeHints = dedent(`
    ## Mode Hints
    - normal: 上記スタイルで自然に回答。
    - meaning/intent: 要点を明確に、短い段落で。
    - diagnosis: 直近の入力を検査し、難所と次の一手を**短く**示す。
    - remake: 文体を保ちつつ整形・圧縮・言い換え。
  `);

  // 7) 最終合成（ベース → 設定 → スタイル → 書式 → ガード → モード）
  const finalSystem = dedent(`
    ${base}

    ${configNote}

    ${resonance}

    ${formatting}

    ${guard}

    ${modeHints}

    ## Enforcement
    - **上記スタイル規則は、ユーザーの文体に関わらず常に優先する。**
    - 1段落は 2〜3 文で区切り、**必ず改行**して余白を残す。
    - I/T 層は必要時のみ、I→T の順で短く分ける。

    # 現在モード: ${mode}
  `);

  /* === LOG: 出力 === */
  try {
    console.log('[SofiaPrompt:finalSystem]', {
      length: finalSystem.length,
      preview: preview(finalSystem, 1000),
    });
  } catch {}

  return finalSystem;
}
