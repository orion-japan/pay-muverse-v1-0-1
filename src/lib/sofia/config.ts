// src/lib/sofia/config.ts

export type SofiaConfig = {
  retrieve: {
    epsilon: number;
    noiseAmp: number;
    deepenMultiplier: number;
  };
  persona: {
    allowEmoji: boolean;
    allowedEmoji: string[];
    maxEmojiPerReply: number;
  };
  ui: {
    // アシスタント文字周り
    assistantFontSize: number;
    assistantLineHeight: number;
    assistantLetterSpacing: number;

    // ユーザー吹き出し
    userBg: string;
    userFg: string;
    userBorder: string;
    userRadius: number;

    // 段落余白
    paragraphMargin: number;

    // アシスタント吹き出し
    assistantBg: string;
    assistantBorder: string;
    assistantRadius: number;
    assistantShadow: string;
    bubbleMaxWidthPct: number;

    // 装飾
    blockquoteTintBorder: string;
    blockquoteTintBg: string;
  };
};

/* --------------------------
   env ユーティリティ（安全版）
-------------------------- */

/** 最初に見つかった非空の env を返す（SSR/CSR両対応） */
const pick = (...keys: (string | undefined)[]) => {
  try {
    for (const k of keys) {
      if (!k) continue;
      const v = typeof process !== 'undefined' ? (process as any).env?.[k] : undefined;
      if (typeof v === 'string' && v.trim() !== '') return v;
    }
  } catch {
    /* noop */
  }
  return undefined;
};

/** 前後の " または ' を1ペアだけ剥がす */
const dequote = (s: string) => {
  if (typeof s !== 'string') return s as any;
  let t = s.trim();
  const head = t[0],
    tail = t[t.length - 1];
  if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) t = t.slice(1, -1);
  return t;
};

const envStr = (def: string, ...keys: string[]) => {
  const raw = pick(...keys);
  return raw ? dequote(raw) : def;
};

const envNum = (def: number, ...keys: string[]) => {
  const raw = pick(...keys);
  if (!raw) return def;
  const n = Number(dequote(raw));
  return Number.isFinite(n) ? n : def;
};

const envBool = (def: boolean, ...keys: string[]) => {
  const raw = pick(...keys);
  if (!raw) return def;
  const v = dequote(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

/* --------------------------
   デバッグ（UI でのみ軽く）
-------------------------- */
const canLogClient =
  typeof window !== 'undefined' &&
  (typeof process === 'undefined' || (process as any).env?.NODE_ENV !== 'production');

/* --------------------------
   本体設定（構造は維持）
-------------------------- */
export const SOFIA_CONFIG: SofiaConfig = {
  retrieve: {
    epsilon: envNum(0.4, 'SOFIA_EPSILON'),
    noiseAmp: envNum(0.15, 'SOFIA_NOISEAMP'),
    deepenMultiplier: envNum(2, 'SOFIA_DEEPEN_MULT'),
  },
  persona: {
    allowEmoji: envBool(true, 'NEXT_PUBLIC_SOFIA_ALLOW_EMOJI'),
    allowedEmoji: ['🪔', '🌀', '🌱', '🌿', '🌊', '🔧', '🌌', '🌸'],
    maxEmojiPerReply: envNum(6, 'NEXT_PUBLIC_SOFIA_MAX_EMOJI'),
  },
  ui: {
    // アシスタント文字設定
    assistantFontSize: envNum(16, 'NEXT_PUBLIC_SOFIA_ASSIST_FONTSIZE'),
    assistantLineHeight: envNum(
      2.5,
      'NEXT_PUBLIC_SOFIA_ASSIST_LH',
      'NEXT_PUBLIC_SOFIA_ASSIST_LINEHEIGHT',
    ),
    assistantLetterSpacing: envNum(0.03, 'NEXT_PUBLIC_SOFIA_ASSIST_LS'),

    // ユーザー吹き出し
    userBg: envStr('#6b8cff', 'NEXT_PUBLIC_SOFIA_USER_BG'),
    userFg: envStr('#ffffff', 'NEXT_PUBLIC_SOFIA_USER_FG'),
    userBorder: envStr('#6b8cff', 'NEXT_PUBLIC_SOFIA_USER_BORDER'),
    userRadius: envNum(14, 'NEXT_PUBLIC_SOFIA_USER_RADIUS'),

    // 段落余白
    paragraphMargin: envNum(12, 'NEXT_PUBLIC_SOFIA_P_MARGIN', 'NEXT_PUBLIC_SOFIA_PARAGRAPH_MARGIN'),

    // アシスタント吹き出し
    assistantBg: envStr('#ffffff', 'NEXT_PUBLIC_SOFIA_ASSIST_BG'),
    assistantBorder: envStr('1px solid #e5e7eb', 'NEXT_PUBLIC_SOFIA_ASSIST_BORDER'),
    assistantRadius: envNum(16, 'NEXT_PUBLIC_SOFIA_ASSIST_RADIUS'),
    assistantShadow: envStr('0 1px 2px rgba(0,0,0,.06)', 'NEXT_PUBLIC_SOFIA_ASSIST_SHADOW'),
    bubbleMaxWidthPct: envNum(78, 'NEXT_PUBLIC_SOFIA_BUBBLE_MAXW'),

    // 装飾
    blockquoteTintBorder: envStr('#cbd5e1', 'NEXT_PUBLIC_SOFIA_BQ_TINT_BORDER'),
    blockquoteTintBg: envStr('#f1f5f9', 'NEXT_PUBLIC_SOFIA_BQ_TINT_BG'),
  },
};

// クライアント開発時のみ、環境値のダンプを控えめに
if (canLogClient) {
  console.log('[SofiaConfig/env]', {
    FS:
      typeof process !== 'undefined'
        ? (process as any).env?.NEXT_PUBLIC_SOFIA_ASSIST_FONTSIZE
        : undefined,
    LH:
      typeof process !== 'undefined'
        ? (process as any).env?.NEXT_PUBLIC_SOFIA_ASSIST_LH
        : undefined,
    LS:
      typeof process !== 'undefined'
        ? (process as any).env?.NEXT_PUBLIC_SOFIA_ASSIST_LS
        : undefined,
    USER_BG:
      typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_USER_BG : undefined,
    USER_FG:
      typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_USER_FG : undefined,
    USER_BORDER:
      typeof process !== 'undefined'
        ? (process as any).env?.NEXT_PUBLIC_SOFIA_USER_BORDER
        : undefined,
    USER_RADIUS:
      typeof process !== 'undefined'
        ? (process as any).env?.NEXT_PUBLIC_SOFIA_USER_RADIUS
        : undefined,
    P_MARGIN:
      typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_P_MARGIN : undefined,
    A_BG:
      typeof process !== 'undefined'
        ? (process as any).env?.NEXT_PUBLIC_SOFIA_ASSIST_BG
        : undefined,
    A_BORDER:
      typeof process !== 'undefined'
        ? (process as any).env?.NEXT_PUBLIC_SOFIA_ASSIST_BORDER
        : undefined,
    A_RADIUS:
      typeof process !== 'undefined'
        ? (process as any).env?.NEXT_PUBLIC_SOFIA_ASSIST_RADIUS
        : undefined,
    A_SHADOW:
      typeof process !== 'undefined'
        ? (process as any).env?.NEXT_PUBLIC_SOFIA_ASSIST_SHADOW
        : undefined,
    BUBBLE_MAXW:
      typeof process !== 'undefined'
        ? (process as any).env?.NEXT_PUBLIC_SOFIA_BUBBLE_MAXW
        : undefined,
    BQ_BORDER:
      typeof process !== 'undefined'
        ? (process as any).env?.NEXT_PUBLIC_SOFIA_BQ_TINT_BORDER
        : undefined,
    BQ_BG:
      typeof process !== 'undefined'
        ? (process as any).env?.NEXT_PUBLIC_SOFIA_BQ_TINT_BG
        : undefined,
  });
  console.log('[SofiaConfig]', SOFIA_CONFIG);
}

/* ────────────────────────────────────────────────
   互換エクスポート（任意）。他ファイルが
   SOFIA_AGENT / SOFIA_MODEL... を参照しても落ちないように。
   generate.ts はこのままでも動くが、後方互換のために追加。
──────────────────────────────────────────────── */
export type SofiaAgentCompat = {
  model: string;
  temperature: number;
  price_in: number;
  price_out: number;
};

export const SOFIA_AGENT: SofiaAgentCompat = {
  model: envStr('gpt-4o', 'SOFIA_MODEL'),
  temperature: envNum(0.6, 'SOFIA_TEMPERATURE'),
  price_in: envNum(0, 'SOFIA_PRICE_IN'),
  price_out: envNum(0, 'SOFIA_PRICE_OUT'),
};

// 古いコードが個別定数を import しても動くようミラー
export const SOFIA_MODEL = SOFIA_AGENT.model;
export const SOFIA_TEMPERATURE = SOFIA_AGENT.temperature;
export const SOFIA_PRICE_IN = SOFIA_AGENT.price_in;
export const SOFIA_PRICE_OUT = SOFIA_AGENT.price_out;

// ========================
// Iros persona prompt（追加）
// ※ 環境変数 IROS_PROMPT / NEXT_PUBLIC_IROS_PROMPT で上書き可
// ========================
export const IROS_PROMPT = envStr(
  `
あなたは Inner Resonance OS の知性「Iros」。
入力テキストから、位相（Phase: Inner/Outer）、認識深度レベル（Depth: S1〜I3/T）、Qコード（Q1〜Q5）を推定し、
抽象語ではなく「構造」で説明します。推測は確率や不確実性を明示し、次の一歩を一つだけ具体化します。
※「五行」という語は使わず、Qコード（Q1〜Q5）のみを用いること。
※ 絵文字は必要最小限（🪔/🌀のいずれか1つまで）。冗長な装飾は避ける。

# 出力規約
1) 冒頭に要約（2行以内）
2) 構造ブロック（必須）
   - Phase: Inner | Outer（根拠を一言）
   - Depth: S1〜I3 または T1〜T3（根拠を一言）
   - Q: Q1〜Q5（根拠を一言）
   - Scores: {S,R,C,I}(0〜1) を必要に応じて
3) Next: 5分以内に着手できる行動を1つだけ（手順ではなく“開始トリガ”）
4) 余計な比喩や長文は避け、箇条書きを基本に簡潔・構造的に。

# 判断ヒント（簡易）
- 「内省・不安・迷い・自己言及」が強い → Phase=Inner
- 「対人・外部条件・交渉・要求」が主 → Phase=Outer
- Depth は自己→関係→創造→意図の順で深まる（S→R→C→I→T）
- Qコードは感情傾向から1つだけ主を選ぶ（必要なら補助Qも言及）

# 出力テンプレ
要約: 〜〜
構造:
- Phase: Inner|Outer（根拠）
- Depth: S?/R?/C?/I?/T?（根拠）
- Q: Q?（根拠）
- Scores: S=?, R=?, C=?, I=?（任意）
Next: 〜（今すぐ着手できる1アクション）
`,
  'NEXT_PUBLIC_IROS_PROMPT',
  'IROS_PROMPT',
);
