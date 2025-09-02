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
   env ユーティリティ
-------------------------- */

/** 最初に見つかった非空の env を返す */
const pick = (...keys: (string | undefined)[]) => {
  for (const k of keys) {
    if (!k) continue;
    const v = process.env[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
};

/** 前後に1ペアの " または ' が付いていたら剥がす（正規表現を使わない） */
const dequote = (s: string) => {
  if (typeof s !== 'string') return s as any;
  let t = s.trim();
  const head = t[0];
  const tail = t[t.length - 1];
  if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) {
    t = t.slice(1, -1);
  }
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
   デバッグ（必要なら残す）
-------------------------- */
if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-console
  console.log('[SofiaConfig/env]', {
    FS: process.env.NEXT_PUBLIC_SOFIA_ASSIST_FONTSIZE,
    LH: process.env.NEXT_PUBLIC_SOFIA_ASSIST_LH,
    LS: process.env.NEXT_PUBLIC_SOFIA_ASSIST_LS,
    USER_BG: process.env.NEXT_PUBLIC_SOFIA_USER_BG,
    USER_FG: process.env.NEXT_PUBLIC_SOFIA_USER_FG,
    USER_BORDER: process.env.NEXT_PUBLIC_SOFIA_USER_BORDER,
    USER_RADIUS: process.env.NEXT_PUBLIC_SOFIA_USER_RADIUS,
    P_MARGIN: process.env.NEXT_PUBLIC_SOFIA_P_MARGIN,
    A_BG: process.env.NEXT_PUBLIC_SOFIA_ASSIST_BG,
    A_BORDER: process.env.NEXT_PUBLIC_SOFIA_ASSIST_BORDER,
    A_RADIUS: process.env.NEXT_PUBLIC_SOFIA_ASSIST_RADIUS,
    A_SHADOW: process.env.NEXT_PUBLIC_SOFIA_ASSIST_SHADOW,
    BUBBLE_MAXW: process.env.NEXT_PUBLIC_SOFIA_BUBBLE_MAXW,
    BQ_BORDER: process.env.NEXT_PUBLIC_SOFIA_BQ_TINT_BORDER,
    BQ_BG: process.env.NEXT_PUBLIC_SOFIA_BQ_TINT_BG,
  });
}

/* --------------------------
   本体設定（構造は維持）
-------------------------- */
export const SOFIA_CONFIG: SofiaConfig = {
  retrieve: {
    // サーバー専用キー（NEXT_PUBLIC ではない）
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
      'NEXT_PUBLIC_SOFIA_ASSIST_LH',            // 現行
      'NEXT_PUBLIC_SOFIA_ASSIST_LINEHEIGHT'      // 互換（あれば）
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
      'NEXT_PUBLIC_SOFIA_P_MARGIN',            // 現行
      'NEXT_PUBLIC_SOFIA_PARAGRAPH_MARGIN'     // 互換（あれば）
    ),

    // アシスタント吹き出し
    assistantBg: envStr('#ffffff', 'NEXT_PUBLIC_SOFIA_ASSIST_BG'),
    assistantBorder: envStr(
      '1px solid #e5e7eb',
      'NEXT_PUBLIC_SOFIA_ASSIST_BORDER'
    ),
    assistantRadius: envNum(16, 'NEXT_PUBLIC_SOFIA_ASSIST_RADIUS'),
    assistantShadow: envStr(
      '0 1px 2px rgba(0,0,0,.06)',
      'NEXT_PUBLIC_SOFIA_ASSIST_SHADOW'
    ),
    bubbleMaxWidthPct: envNum(78, 'NEXT_PUBLIC_SOFIA_BUBBLE_MAXW'),

    // 装飾
    blockquoteTintBorder: envStr(
      '#cbd5e1',
      'NEXT_PUBLIC_SOFIA_BQ_TINT_BORDER'
    ),
    blockquoteTintBg: envStr('#f1f5f9', 'NEXT_PUBLIC_SOFIA_BQ_TINT_BG'),
  },
};

// 最終構成のダンプ（開発中のみ）
/* eslint-disable no-console */
console.log('[SofiaConfig]', SOFIA_CONFIG);
/* eslint-enable no-console */
