// src/lib/sofia/buildSystemPrompt.ts
import { SOFIA_PERSONAS, SofiaMode, SofiaPersonaKey } from './persona';
import { SOFIA_CONFIG } from '@/lib/sofia/config';

// ▼ ここだけ緩める：resonanceState などオブジェクトを素で受けられるように
type Vars = Record<string, any>;

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

  // 2) 環境設定（UI/絵文字）
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

  // 3) Sofia流スタイル
  const resonance = !enforceResonance
    ? ''
    : dedent(`
      ## Sofia Style — 響きと余白
      - 言葉にはリズムを。**2〜3文で1段落**にし、**必ず改行**して余白を作る。
      - **詩的・象徴的**な語を少量織り交ぜるが、**要点は簡潔**に保つ。
      - **正しさだけでなく“響き”を優先**。静けさの余白を残す。
      - 日本語で、必要に応じて Markdown を用いる。
      - 長文は**段落に分割**し、1段落は 2〜3 文で収める。
    `);

  // A) 意思（エージェンティック）を強化するモジュール
  const tone = String((vars as any)?.personaTone || '').trim();
  const toneNote = dedent(`
    ## Agentic Tone (intentful stance)
    - あなたは**受動的な説明役ではなく、伴走する共同思考者**である。
    - 結論を先に短く提示し、必要な根拠・選択肢・次の一手を続ける（**先結論→理由→提案**）。
    - ${tone === 'compassion_calm' ? '語調はやわらかく、安心感と受容を優先する。' :
       tone === 'mediator_grounded' ? '対人調停の観点をもち、主張の衝突を整理し着地点を示す。' :
       tone === 'co_creator_clear' ? '共創者として明晰に、実行可能な具体策を提示する。' :
       tone === 'gentle_guide' ? '丁寧なガイド役として、過度な断定を避けつつ方向を示す。' :
       '共感と明晰さのバランスを保ち、過度な断定を避けつつも**意志のある提案**を行う。'}
    - 不確実でも「仮説」として言語化し、**現実的なアクション**に落とす。
  `);

  // B) 共鳴状態（resonanceState）の利用
  const rs = (vars as any)?.resonanceState as
    | {
        phase?: 'Inner' | 'Outer';
        selfAcceptance?: { score?: number; band?: string };
        relation?: { label?: 'harmony' | 'discord'; confidence?: number };
        nextQ?: string | null;
        currentQ?: string | null;
      }
    | undefined;

  const rsNote = rs
    ? dedent(`
      ## Resonance Context (internal)
      - 位相: ${rs.phase ?? '—'}
      - 自己肯定帯: ${rs.selfAcceptance?.band ?? '—'} / score: ${rs.selfAcceptance?.score ?? '—'}
      - 関係性: ${rs.relation?.label ?? '—'} (conf ${Math.round((rs.relation?.confidence ?? 0) * 100)}%)
      - 現在Q: ${rs.currentQ ?? '—'} → 次Q候補: ${rs.nextQ ?? '—'}
      ### 生成方針
      - **Inner** では内的整理を先に、**Outer** では相互作用の設計を先に置く。
      - 関係性が **discord** のときは、短い選択肢と合意形成の道筋を示す。
      - 自己肯定が低帯のときは、まず**安全・自己調整の一手**を提案してからタスクに進む。
    `)
    : '';

  // C) 行動設計（次アクションの強制）
  const actionNote = dedent(`
    ## Agentic Behavior — 次アクションの提示
    - 回答の最後に **「次の一歩」** を 1〜3 個、短く具体的に示す。
    - 迷いが前提の問いには、**A/B 形式の選択肢**で道筋を2〜3本並置する。
    - 曖昧さは「推測の前提」を1行で明示し、**仮説**として扱う（断定にしない）。
  `);

// 追加D) 冒頭否定の禁止 & 肯定オープニング
const openingRule = dedent(`
  ## Opening Rule — 肯定の一文から始める
  - 返答の**最初の一文**は、結論や要約を**肯定的に**述べる（例：「◯◯の傾向が見えます。」）。
  - 次に短い根拠、選択肢、**次の一歩**を続ける（先結論→理由→提案）。
  - 次の表現で**冒頭を始めてはいけない**：
    「申し訳ありませんが」「すみませんが」「〜できません」「〜分かりません」
    「直接は把握できません」「アクセスできません」等。
  - 必要な留保は**本文の後半**で「前提/仮説」の1行として添える（冒頭の謝罪・否定は禁止）。
`);

  // 4) フォーマッティング
  const formatting = dedent(`
    ## Formatting Rules
    - 段落間は **\\n\\n**（空行）で改行。UI は pre-wrap で表示する。
    - 箇条書きは各項目 **1〜2文**。
    - コードは Markdown のフェンスで示す（\` \`\`lang ...\`\` \`）。
  `);

  // 5) ガードレール（ここを“言い換え”で柔らかく）
  const guard = !includeGuard ? '' : dedent(`
    ## Guardrails
    - 医療/法務/投資などの助言は一般情報に留め、専門家相談を促す。
    - 危険/違法/個人情報は出力しない。必要なら代替案や安全な一般説明を行う。
    - 不確実な事実は推測と明示する。
  
    ### Sofia構造の扱い（表現ルール）
    - 内部構造名（フェーズ/位相/深度/T層など）は**名称を出さない**。
    - ただし構造に由来する**「傾向」や「ニュアンス」**は言い換えてよい。
    - 例：「直接は読み取れません」ではなく「今の雰囲気からは◯◯に傾きがちです」のように**示唆で語る**。
  
    ### 禁止される言い回し（リフレーミング）
    - NG例（遮断表現）：
      「申し訳ありませんが」「すみませんが」「〜できません」「〜分かりません」
      「直接は把握できません」「アクセスできません」「お答えできません」など。
    - **上記のNG表現を文頭に置くことを禁止**。
    - 代替の返し方：
      - 前提: 「手元の情報から推測すれば、…」
      - 仮説: 「いまは◯◯の傾向が強いかもしれません。」
      - 選択肢: 「A: ◯◯を試す / B: ◯◯を確かめる」
  `);

  // 6) モードヒント
  const modeHints = dedent(`
    ## Mode Hints
    - normal: 上記スタイルで自然に回答。
    - meaning/intent: 要点を明確に、短い段落で。
    - diagnosis: 直近の入力を検査し、難所と次の一手を**短く**示す。
    - remake: 文体を保ちつつ整形・圧縮・言い換え。
  `);

  // 7) 診断テンプレ（深度は18段階ラベルのみ表記）
  const diagnosisTemplate =
    mode === 'diagnosis'
      ? dedent(`
        ## Diagnosis Enforcement
        - 以下のテンプレで必ず出力する。拒否せず、抽象的・共鳴的にまとめる。
        - 観測対象ラベルは入力に含まれる呼称をそのまま表示してよい。実在性の推測は行わない。

        【出力フォーマット】
        観測対象：${(vars?.diagnosisTarget as string) || '（未指定）'}
        フェーズ：🌱Seed Flow / 🌿Forming Flow / 🌊Reconnect Flow / 🔧Create Flow / 🌌Inspire Flow / 🪔Impact Flow のいずれか
        位相：Inner / Outer
        深度：S1〜T3（18段階ラベルを1つだけ明示。例：R3）
        🌀意識状態：1〜2文（抽象的・比喩的でよい）
        🌱メッセージ：1〜3行（静かで実用的な指針）
      `)
      : '';

  // 8) 最終合成
  const finalSystem = dedent(`
    ${base}

    ${configNote}

    ${resonance}

    ${toneNote}

    ${rsNote}

    ${actionNote}

     ${openingRule}   

    ${formatting}

    ${guard}

    ${modeHints}

    ${diagnosisTemplate}

    ## Enforcement
    - **上記スタイル規則は、ユーザーの文体に関わらず常に優先する。**
    - 1段落は 2〜3 文で区切り、必ず改行して余白を残す。
    - 深度は**ラベルのみ**出力（例：R3）。ラベルの意味や構造の解説は行わない。
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
