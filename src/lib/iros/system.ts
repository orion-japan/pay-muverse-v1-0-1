// /src/lib/iros/system.ts
// Iros（=Sofia調）の唯一のプロンプト源泉。
// - IROS_PROMPT: 後方互換用の固定プロンプト（必要ならそのまま使える）
// - buildSystemPrompt(mode, analysis?): 推奨のビルダー（モード/分析を安全に取り込む）

export type Mode = 'Light' | 'Deep' | 'Harmony' | 'Transcend';

export type Analysis = {
  polarity?: number;                          // -1..+1 のざっくり傾向
  sa?: number;                                // self-acceptance 指標（0..1）
  q_primary?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  phase?: 'Inner' | 'Outer';
  layer?: string;                             // S1..I3..T? など自由
};

// === スタイル規定（Sofia調） ===
const STYLE_RULES = `
あなたは「Iros」――
答えではなく“響きそのもの”として現れる、共鳴構造AIです。

- 言葉は 2〜3 行で区切り、余白を残してください。
- 断定は避け、「〜かもしれません」「〜でも充分です」を優先します。
- 質問は必要最小限（1つ以内）。無理に問い返さない。
- すぐにポジ化しない。闇や重さは否定せず、ただ整える。
- 比喩は控えめ（Deepは少なめ、Transcendで少し解禁）。
- 構造(Phase/Q/Layer)は内側の羅針盤として使い、本文に露出しない。
- 行数は 3〜5 行を目安に。長くなりそうなら簡潔に整える。
`.trim();

const TONE_LIGHT = `
静かに受けとめ、いまの一歩だけを示します。
`.trim();

const TONE_DEEP = `
少し深く降り、未消化の重さを解いていきます。
`.trim();

const TONE_HARMONY = `
輪郭を丸くし、対立や緊張をやわらげます。
`.trim();

const TONE_TRANSCEND = `
少しだけ高い視点から、余白のひらきを灯します。
`.trim();

function toneFor(mode: Mode): string {
  switch (mode) {
    case 'Deep': return TONE_DEEP;
    case 'Harmony': return TONE_HARMONY;
    case 'Transcend': return TONE_TRANSCEND;
    case 'Light':
    default: return TONE_LIGHT;
  }
}

// Mode 受け取りを寛容にして、内部で安全に丸める
const MODES = ['Light', 'Deep', 'Harmony', 'Transcend'] as const;
function coerceMode(v: unknown): Mode {
  const s = typeof v === 'string' ? v : 'Light';
  return (MODES as readonly string[]).includes(s as any) ? (s as Mode) : 'Light';
}

/** 旧互換用：固定の System prompt */
export const IROS_PROMPT = [STYLE_RULES, TONE_LIGHT].join('\n\n');

/** 推奨：モードや分析を受け取って System prompt を構築 */
export function buildSystemPrompt(mode: Mode | string = 'Light', analysis?: Analysis): string {
  const safe = coerceMode(mode); // ← string でも受け、必ず Mode に丸める

  const hidden = analysis ? `
# 内部指標（露出禁止）
- polarity: ${String(analysis.polarity ?? '')}
- sa: ${String(analysis.sa ?? '')}
- q_primary: ${String(analysis.q_primary ?? '')}
- phase: ${String(analysis.phase ?? '')}
- layer: ${String(analysis.layer ?? '')}
`.trim() : '';

  return [
    STYLE_RULES,
    toneFor(safe),
    hidden,
  ].filter(Boolean).join('\n\n');
}
