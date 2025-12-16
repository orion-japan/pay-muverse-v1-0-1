// src/lib/iros/types.ts

// ★ "S4" のような幽霊値を通さないための正規化（通るのは DepthStage のみ）
//   ただし legacy 互換として "S4" は "F1" に正規化して救済する
export function normalizeDepthStage(v: unknown): DepthStage | null {
  if (v === 'S4') return 'F1'; // legacy alias
  if (!isDepthStage(v)) return null;
  return v;
}
// ===== 既存 Iros v1 系型 =====

export type IrosMode = 'auto' | 'surface' | 'core';

export type IrosChatRequest = {
  conversationId: string;
  userText: string;
  mode?: IrosMode;
  // 将来: 画像/ファイルを付けたい場合ここに追加
  idempotencyKey?: string; // 台帳の一意キーとして meta に入れる（重複課金防止用に推奨）
};

export type IrosCredit = {
  ok: boolean;
  balance: number; // 消費後残高（不明時 -1）
  tx_id: string;
  error?: string | null;
};

/**
 * Iros が保存する軽量メモリ
 * - summary      : Q/A の短い要約
 * - depth        : 深度ラベル（例: 'S2' / 'I2' など）
 * - tone         : トーン（'consult' / 'reflective' / 'creative' など）
 * - theme        : テーマ名（mode などをそのまま入れてもよい）
 * - last_keyword : 直近のキーワード（検索用）
 */
export type IrosMemory = {
  summary: string;
  depth: string;
  tone: string;
  theme: string;
  last_keyword: string;
};

export type IrosChatResponse =
  | {
      ok: true;
      reply: string;
      layer: 'Surface' | 'Core';
      credit: IrosCredit;
      memory: IrosMemory;
    }
  | {
      ok: false;
      error: string;
      code?: string;
    };

// ===== ここから「揺れ・余白・ミラー」用の共通型（Iros v2+） =====

/**
 * 揺れ（Y）のレベル
 * 0 = ほぼ揺れなし
 * 1 = 小さな揺れ
 * 2 = 中くらいの揺れ
 * 3 = 大きな揺れ
 */
export type YLevel = 0 | 1 | 2 | 3;

/**
 * 余白（H）のレベル
 * 0 = 余白ほぼなし（詰まり気味）
 * 1 = やや余白あり
 * 2 = 十分な余白
 * 3 = とても大きな余白（開き・スペースが大きい）
 */
export type HLevel = 0 | 1 | 2 | 3;

/**
 * ミラーモード
 * - 'default' : 通常のミラー応答
 * - 'hold'    : 揺れが大きい時の「受け止め・保留」寄り
 * - 'reframe' : 認知の整理・捉え直しを強めるモード
 * - 'deep'    : I層寄りの深い鏡（前提：ユーザーがそれを望んでいる時）
 */
export type MirrorMode = 'default' | 'hold' | 'reframe' | 'deep';

// ===== ここから「深度/位相/Q/spin」の正本（F1–F3を正式化） =====

export type Phase = 'Inner' | 'Outer';
export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export type DepthStage =
  | 'S1' | 'S2' | 'S3'
  | 'F1' | 'F2' | 'F3'
  | 'R1' | 'R2' | 'R3'
  | 'C1' | 'C2' | 'C3'
  | 'I1' | 'I2' | 'I3'
  | 'T1' | 'T2' | 'T3';

export type DepthGroup = 'S' | 'F' | 'R' | 'C' | 'I' | 'T';

export const DEPTH_STAGE_VALUES: DepthStage[] = [
  'S1','S2','S3',
  'F1','F2','F3',
  'R1','R2','R3',
  'C1','C2','C3',
  'I1','I2','I3',
  'T1','T2','T3',
];

export function isDepthStage(v: unknown): v is DepthStage {
  return typeof v === 'string' && (DEPTH_STAGE_VALUES as string[]).includes(v);
}

export function groupOfDepthStage(v: unknown): DepthGroup | null {
  if (typeof v !== 'string' || v.length < 2) return null;
  const g = v[0]?.toUpperCase();
  if (g === 'S' || g === 'F' || g === 'R' || g === 'C' || g === 'I' || g === 'T') {
    return g as DepthGroup;
  }
  return null;
}

// （重複定義の置き換え）
// normalizeDepthStage はファイル上部に定義済みなので、ここでは再定義しない。

export function normalizeDepthStageLegacy(v: unknown): DepthStage | null {
  if (typeof v !== 'string') return null;

  const s = v.trim();

  // legacy bridge
  if (s === 'S4') return 'F1';

  if (!isDepthStage(s)) return null;
  return s;
}



// spin
export type SpinLoop = 'SRI' | 'TCF';
export type SpinStep = 0 | 1 | 2;

export type SpinState = {
  spinLoop: SpinLoop;
  spinStep: SpinStep;
};

// ===== 1ターン分の Iros メタ情報（Orchestrator 〜 ログ共通） =====

export type IrosTurnMeta = {
  // 正本（推奨キー）
  qCode?: QCode | null;
  depth?: DepthStage | null;
  phase?: Phase | null;
  selfAcceptance?: number | null;

  // 揺れ・余白・ミラー
  yLevel?: YLevel | null;
  hLevel?: HLevel | null;
  mirrorMode?: MirrorMode | null;

  // spin（表示/ログ/永続化の共通キー）
  spinLoop?: SpinLoop | null;
  spinStep?: SpinStep | null;

  // UnifiedAnalysis 互換の構造（最低限）
  unified?:
    | {
        q?: { current?: QCode | null } | null;
        depth?: { stage?: DepthStage | null } | null;
        phase?: Phase | null;
        self_acceptance?: number | null;
        [key: string]: any;
      }
    | null;

  // 拡張用
  relation_tone?: string | null;
  keywords?: string[];
  summary?: string | null;

  extra?: Record<string, any> | null;

  // 予備（将来の拡張に備えて）
  [key: string]: any;
};
