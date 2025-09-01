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
  
  /** 数値変換ユーティリティ（未設定は既定値へ） */
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  
  /** 環境変数の生値をダンプ（デバッグ用。必要なら消してください） */
  if (typeof window !== "undefined") {
    // client 側でも見えるように NEXT_PUBLIC のみログ
    // eslint-disable-next-line no-console
    console.log("[SofiaConfig/env]", {
      EPSILON: process.env.NEXT_PUBLIC_SOFIA_EPSILON,
      NOISE: process.env.NEXT_PUBLIC_SOFIA_NOISEAMP,
      DEEPEN: process.env.NEXT_PUBLIC_SOFIA_DEEPEN_MULT,
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
  
  /** Sofia 全体設定（env が無ければ安全な既定値） */
  export const SOFIA_CONFIG: SofiaConfig = {
    retrieve: {
      epsilon: num(process.env.NEXT_PUBLIC_SOFIA_EPSILON, 0.2),
      noiseAmp: num(process.env.NEXT_PUBLIC_SOFIA_NOISEAMP, 0.12),
      deepenMultiplier: num(process.env.NEXT_PUBLIC_SOFIA_DEEPEN_MULT, 1.3),
    },
    persona: {
      allowEmoji: process.env.NEXT_PUBLIC_SOFIA_ALLOW_EMOJI === "true",
      allowedEmoji: ["🪔", "🌀", "🌱", "🌿", "🌊", "🔧", "🌌", "🌸"],
      maxEmojiPerReply: num(process.env.NEXT_PUBLIC_SOFIA_MAX_EMOJI, 1),
    },
    ui: {
      // アシスタント文字設定
      assistantFontSize: num(process.env.NEXT_PUBLIC_SOFIA_ASSIST_FONTSIZE, 15),
      assistantLineHeight: num(process.env.NEXT_PUBLIC_SOFIA_ASSIST_LH, 1.85),
      assistantLetterSpacing: num(process.env.NEXT_PUBLIC_SOFIA_ASSIST_LS, 0.01),
  
      // ユーザー吹き出し
      userBg: process.env.NEXT_PUBLIC_SOFIA_USER_BG ?? "#6b8cff",
      userFg: process.env.NEXT_PUBLIC_SOFIA_USER_FG ?? "#ffffff",
      userBorder: process.env.NEXT_PUBLIC_SOFIA_USER_BORDER ?? "#6b8cff",
      userRadius: num(process.env.NEXT_PUBLIC_SOFIA_USER_RADIUS, 14),
  
      // 段落余白
      paragraphMargin: num(process.env.NEXT_PUBLIC_SOFIA_P_MARGIN, 6),
  
      // アシスタント吹き出し
      assistantBg: process.env.NEXT_PUBLIC_SOFIA_ASSIST_BG ?? "#ffffff",
      // ← 既定値は「CSS として有効な完全な値」にしておく
      assistantBorder:
        process.env.NEXT_PUBLIC_SOFIA_ASSIST_BORDER ?? "1px solid #e5e7eb",
      assistantRadius: num(process.env.NEXT_PUBLIC_SOFIA_ASSIST_RADIUS, 16),
      assistantShadow:
        process.env.NEXT_PUBLIC_SOFIA_ASSIST_SHADOW ??
        "0 1px 2px rgba(0,0,0,.06)",
      // ← ここは .env のキーに合わせる（MAXW）
      bubbleMaxWidthPct: num(process.env.NEXT_PUBLIC_SOFIA_BUBBLE_MAXW, 78),
  
      // 装飾（.env のキーに合わせる：BQ_TINT_*）
      blockquoteTintBorder:
        process.env.NEXT_PUBLIC_SOFIA_BQ_TINT_BORDER ?? "#cbd5e1",
      blockquoteTintBg:
        process.env.NEXT_PUBLIC_SOFIA_BQ_TINT_BG ?? "#f1f5f9",
    },
  };
  
  // 最終構成のダンプ
  // eslint-disable-next-line no-console
  console.log("[SofiaConfig]", SOFIA_CONFIG);
  