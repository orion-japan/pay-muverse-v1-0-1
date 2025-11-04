// src/lib/mui/types.ts

// ── 既存（そのまま） ───────────────────────────────────────────
export type Phase = 'Inner' | 'Outer' | 'Bridge' | 'Flow' | 'Calm';
export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

/** band は表記揺れを吸収するため広めに許容 */
export type SelfBand = 'lt20' | '10_40' | '20_40' | '40_70' | '70_90' | 'gt90';

export type SelfAcceptance = {
  score: number; // 0-100
  band: SelfBand;
};

export type RelationQuality = {
  label: 'harmony' | 'discord' | 'neutral';
  confidence?: number;
};

/** 返ってきた band を既定の型に正規化（任意で使用） */
export function normalizeBand(b: string | null | undefined): SelfBand {
  const t = String(b ?? '').trim();
  if (t === 'lt20') return 'lt20';
  if (t === '10_40') return '10_40';
  if (t === '20_40') return '20_40';
  if (t === '40_70') return '40_70';
  if (t === '70_90') return '70_90';
  if (t === 'gt90') return 'gt90';
  return '40_70';
}

// ── ここから拡張（AI返却/課金/保存で使用） ────────────────────────

// 会話ステージ（ビジネスの 1〜4 フェーズ）
export type ConversationStage = 1 | 2 | 3 | 4;

// UI表示のフォーカス名（日本語）
export type Focus =
  | '感情整理' // Stage 1
  | '事実整理' // Stage 2
  | '選択肢検討' // Stage 3
  | '合意形成' // Stage 4
  | '安全確保';

export type RiskLevel = 0 | 1 | 2 | 3; // 3=至急

export const PHASE_LABEL: Record<ConversationStage, Focus> = {
  1: '感情整理',
  2: '事実整理',
  3: '選択肢検討',
  4: '合意形成',
};

// 開幕（無料）レスポンス
export type AiOpening = {
  opening_message: string; // 3行以内
  focus: Focus; // 通常 '感情整理'
  next_question: string; // "？" で終える
  chips: string[]; // 0-3 個
  risk_level: RiskLevel;
};

// 継続（有料）レスポンス
export type AiTurn = {
  message: string; // 3行以内
  next_question: string; // "？" で終える
  chips: string[]; // 0-3 個
  phase_done?: boolean; // Stage4 最終で true
  risk_level: RiskLevel;
};

// agent/mui 呼び出しに使うペイロード
export type AgentMuiPayload = {
  system: string; // System プロンプト
  user: string; // User コンテキスト
  phase?: ConversationStage | 'opening'; // 生成側のモード
};

// 価格（半額ローンチ。未設定時は既定値）
export const PRICES = {
  phase2: Number(process.env.NEXT_PUBLIC_PRICE_P2 ?? 280),
  phase3: Number(process.env.NEXT_PUBLIC_PRICE_P3 ?? 980),
  phase4: Number(process.env.NEXT_PUBLIC_PRICE_P4 ?? 1980),
  bundle234: Number(process.env.NEXT_PUBLIC_PRICE_BUNDLE ?? 3180),
} as const;

// 保存API（/api/agent/mui/stage/save）にPOSTするボディ
// ※ あなたの保存ルート互換のため phase は既存 Phase に 'Mixed' を加えています
export type StageSaveBody = {
  user_code: string;
  seed_id: string;
  sub_id:
    | 'stage1-1'
    | 'stage1-2'
    | 'stage1-3'
    | 'stage2-1'
    | 'stage2-2'
    | 'stage2-3'
    | 'stage3-1'
    | 'stage3-2'
    | 'stage3-3'
    | 'stage4-1'
    | 'stage4-2'
    | 'stage4-3';
  phase: Phase | 'Mixed'; // 互換のため 'Mixed' も許容
  depth_stage: string; // 例: 'R3'
  q_current: QCode; // 'Q1'..'Q5'
  next_step: string; // UIの次アクション（chips等）
  result?: any; // フェーズ別のJSON
  tone?: any; // 任意メタ（guardrails等）
};
