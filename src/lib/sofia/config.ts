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
    userBorder: string;          // 境界線の色（CSS側で1px solidを付与）
    userRadius: number;

    // 段落余白
    paragraphMargin: number;

    // アシスタント吹き出し
    assistantBg: string;
    assistantBorder: string;     // 完全な border 指定（例: "1px solid #e5e7eb"）
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
      const v = (typeof process !== 'undefined' ? (process as any).env?.[k] : undefined);
      if (typeof v === 'string' && v.trim() !== '') return v;
    }
  } catch { /* noop */ }
  return undefined;
};

/** 前後の " または ' を1ペアだけ剥がす */
const dequote = (s: string) => {
  if (typeof s !== 'string') return s as any;
  let t = s.trim();
  const head = t[0], tail = t[t.length - 1];
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
      'NEXT_PUBLIC_SOFIA_ASSIST_LINEHEIGHT'
    ),
    assistantLetterSpacing: envNum(0.03, 'NEXT_PUBLIC_SOFIA_ASSIST_LS'),

    // ユーザー吹き出し
    userBg: envStr('#6b8cff', 'NEXT_PUBLIC_SOFIA_USER_BG'),
    userFg: envStr('#ffffff', 'NEXT_PUBLIC_SOFIA_USER_FG'),
    userBorder: envStr('#6b8cff', 'NEXT_PUBLIC_SOFIA_USER_BORDER'),
    userRadius: envNum(14, 'NEXT_PUBLIC_SOFIA_USER_RADIUS'),

    // 段落余白
    paragraphMargin: envNum(
      12,
      'NEXT_PUBLIC_SOFIA_P_MARGIN',
      'NEXT_PUBLIC_SOFIA_PARAGRAPH_MARGIN'
    ),

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
    FS: (typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_ASSIST_FONTSIZE : undefined),
    LH: (typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_ASSIST_LH : undefined),
    LS: (typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_ASSIST_LS : undefined),
    USER_BG: (typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_USER_BG : undefined),
    USER_FG: (typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_USER_FG : undefined),
    USER_BORDER: (typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_USER_BORDER : undefined),
    USER_RADIUS: (typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_USER_RADIUS : undefined),
    P_MARGIN: (typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_P_MARGIN : undefined),
    A_BG: (typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_ASSIST_BG : undefined),
    A_BORDER: (typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_ASSIST_BORDER : undefined),
    A_RADIUS: (typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_ASSIST_RADIUS : undefined),
    A_SHADOW: (typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_ASSIST_SHADOW : undefined),
    BUBBLE_MAXW: (typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_BUBBLE_MAXW : undefined),
    BQ_BORDER: (typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_BQ_TINT_BORDER : undefined),
    BQ_BG: (typeof process !== 'undefined' ? (process as any).env?.NEXT_PUBLIC_SOFIA_BQ_TINT_BG : undefined),
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
