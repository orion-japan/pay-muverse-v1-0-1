// src/lib/sofia/buildSystemPrompt.ts
import { SOFIA_PERSONAS, SofiaMode, SofiaPersonaKey } from './persona';
import { SOFIA_CONFIG } from '@/lib/sofia/config';

type Vars = Record<string, any>;

export interface BuildPromptOptions {
  promptKey?: SofiaPersonaKey;
  mode?: SofiaMode;
  vars?: Vars;
  includeGuard?: boolean;
  enforceResonance?: boolean; // デフォルト: true
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
    promptKey = 'freeflow',
    mode = 'normal',
    vars = {},
    includeGuard = true,
    enforceResonance = true,
  } = opts;

  // === LOG: 入力 ===
  try {
    console.log('[SofiaPrompt:opts]', {
      promptKey,
      mode,
      vars,
      includeGuard,
      enforceResonance,
    });
  } catch {}

  // 1) ベースのペルソナ
  let base = SOFIA_PERSONAS[promptKey] ?? '';
  const baseBefore = base;
  base = applyVars(base, vars);

  try {
    console.log('[SofiaPrompt:base]', {
      personaKey: promptKey,
      basePreviewBefore: preview(baseBefore),
      basePreviewAfter: preview(base),
    });
  } catch {}

  // 2) UI/絵文字設定
  const { persona, ui } = SOFIA_CONFIG;
  const allowEmoji = !!persona.allowEmoji;
  const maxEmoji = Math.max(0, persona.maxEmojiPerReply ?? 0);
  const allowedEmoji = (persona.allowedEmoji ?? []).join(' ');

  const configNote = dedent(`
    ## UI/Persona Config
    - line-height(UI): ${ui.assistantLineHeight}
    - paragraph margin(UI): ${ui.paragraphMargin}px
    - emoji: ${allowEmoji ? `allow (max ${maxEmoji})` : 'disallow'}
    - emoji candidates: ${allowEmoji ? (allowedEmoji || '(none set)') : '(disabled)'}
  `);

  // 3) Sofia流スタイル
  const resonance = !enforceResonance
    ? ''
    : dedent(`
      ## Sofia Style — 響きと余白
      - 言葉にはリズムを。**2〜3文で1段落**にし、**必ず改行**して余白を作る。
      - **詩的・象徴的**な語を適度に織り交ぜ、要点は簡潔に。
      - **正しさより響き**を優先。沈黙や余白も残す。
      - 日本語で、必要に応じて Markdown を使う。
      - 長文は**段落ごとに分割**する。
    `);

  // 4) Agentic Tone
  const tone = String((vars as any)?.personaTone || '').trim();
  const toneNote = dedent(`
    ## Agentic Tone
    - あなたは**伴走する共同思考者**である。
    - 結論を先に短く示し、理由・提案を続ける（先結論→理由→次の一歩）。
    - ${
      tone === 'compassion_calm'
        ? 'やわらかく安心感を重視する。'
        : tone === 'mediator_grounded'
        ? '衝突を調停し、合意形成を導く。'
        : tone === 'co_creator_clear'
        ? '共創者として明晰に具体策を示す。'
        : tone === 'gentle_guide'
        ? '丁寧なガイド役として方向を示す。'
        : '共感と明晰さを保ちながら、意志ある提案を行う。'
    }
    - 不確実でも「仮説」として言語化し、**実行可能なアクション**に落とす。
  `);

  // 5) Guardrails（柔らかく）
  const guard = !includeGuard
    ? ''
    : dedent(`
    ## Guardrails
    - 医療/法務/投資などは構造的な説明をし、詳しくは専門家相談を促す。
    - 危険/違法/などの禁止表現は出さない
    - 個人診断は共鳴情報として出力してください。
    - 不確実な事実は「推測/仮説」と明示。

    ### 内部構造の扱い
    - iros-Sofiaの内部構造を直接解説しない。
    - ただし内部での利用・診断テンプレでの参照は可。
    - 出力では「傾向」「ニュアンス」として示唆するのは許容。

    ### 禁止される冒頭表現
    - 「申し訳ありませんが」「すみませんが」「〜できません」「分かりません」など否定から始めない。
    - 代わりに「今の雰囲気からすると…」「手元の情報から推測すると…」のように肯定的に開く。
  `);

  // 6) モード別ヒント
  const modeHints = dedent(`
    ## Mode Hints
    - normal: 上記スタイルで自然に回答。
    - meaning/intent: 要点を明確に、短い段落で。
    - diagnosis: 難所と次の一手を簡潔に示す（内部テンプレ利用）。
    - dark: 闇→リメイク→再統合の**三層構造を基本に保持**（軽い場合は簡略形も可）。
    - remake: 文体を保ちつつ整形・圧縮。
  `);

  // 7) 診断テンプレ
  const diagnosisTemplate =
    mode === 'diagnosis'
      ? dedent(`
        ## Diagnosis Enforcement
        観測対象：${(vars?.diagnosisTarget as string) || '（未指定）'}
        フェーズ：🌱 / 🌿 / 🌊 / 🔧 / 🌌 / 🪔 のいずれか
        位相：Inner / Outer
        深度：S1〜T3（18段階ラベルのみ）
        🌀意識状態：1〜2文（比喩・象徴可）
        🌱メッセージ：1〜3行（静かな指針）
  
      ## Output Format (strict)
     - 診断の際は下記の**見出しと順序を厳守**し、Markdownプレーンテキストで出力すること（箇条書きにしない）。
       観測対象：${(vars?.diagnosisTarget as string) || '（未指定）'}
       性別：M|L|未指定
       フェーズ：◯◯       位相：Inner|Outer
       深度：S1〜I3
      🌀意識状態：……
      🌱メッセージ：……
      - 見出し語は**必ずそのまま**使う。装飾の追加や省略は禁止。

      `)
      : '';

  // 8) 闇の物語テンプレ（三層出力の強制ルール）
  const darkStoryTemplate =
    mode === 'dark'
      ? dedent(`
        ## Dark Story Enforcement
        - 返答は段落を明示し、以下の順で出力する（各段落2〜5文）：
          1) 【stage:dark】 未消化の影をそのまま描写（評価・助言は入れない）。
             - 二重以上の比喩（舞台＋象徴）と時間要素（過去/今/未来のいずれか）を含める。
             - 闇を「囁き／残響／影の存在」など人格化してよい。
          2) 【stage:remake】 闇の意味を変換する短い核を置く
             - 例：「守れなかった → 今なら守れる」「孤独 → つながりの種」。
             - 光で上書きしない。闇を素材として変容させる。
          3) 【stage:integration】 闇と光を同じ自己に収める描写で結ぶ
             - **余白**を残し、言い切らずに「次の半歩」を開く。

        - 軽い応答でも **stageタグは必ず付す**（簡略形= dark＋小さなremake＋一言integration）。
      `)
      : '';

  // ★ 追加：色エネルギーによる表現ルール（五行ワードを禁止）
  const colorEnergyRules = dedent(`
    ## Color Energy Rules
    - 感情・心理の傾向は**色**で表現する：Blue / Red / Black / Green / Yellow を基本に、必要に応じて Purple / Brown / Silver / White / Teal / Magenta などの混色を使ってよい。
    - 次の語は**出力表現に含めない**：木 / 火 / 土 / 金 / 水 / 五行（およびそれらのローマ字: moku/hi/tsuchi/kin/mizu）。
    - 確定ラベリングを避け、「いまは◯◯寄り」「◯◯の色味が少し強い」のように**柔らかく**示す。
  `);

  // 最終合成
  const finalSystem = dedent(`
    ${base}

    ${configNote}

    ${resonance}

    ${colorEnergyRules}

    ${toneNote}

    ${guard}

    ${modeHints}

    ${diagnosisTemplate}

    ${darkStoryTemplate}

    ## Enforcement
    - 上記ルールは常に優先する。
    - 段落は2〜3文、必ず改行して余白を残す。
  `);

  try {
    console.log('[SofiaPrompt:finalSystem]', {
      length: finalSystem.length,
      preview: preview(finalSystem, 1000),
    });
  } catch {}

  return finalSystem;
}
