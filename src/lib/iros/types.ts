// src/lib/iros/types.ts

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
 *
 * 実装側では 0–3 の数値として扱う前提にしておく。
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
 *
 * 実際のロジックは resolveMirrorMode 側で決定する。
 */
export type MirrorMode = 'default' | 'hold' | 'reframe' | 'deep';

/**
 * 1ターン分の Iros メタ情報（Orchestrator 〜 ログ共通）
 * 既存 meta との互換を優先しつつ、揺れ・余白・ミラーのフィールドも追加。
 *
 * - IrosMeta / UnifiedAnalysis に寄せたフィールド名
 * - DB(jsonb) にそのまま入れても壊れないよう緩めの型にしている
 */
export type IrosTurnMeta = {
  // 既存フィールド（名称は route.ts / UnifiedAnalysis に合わせて緩くしておく）
  qCode?: string | null;
  depth?: string | null;
  phase?: string | null;
  selfAcceptance?: number | null;

  // 揺れ・余白・ミラー
  yLevel?: YLevel | null;
  hLevel?: HLevel | null;
  mirrorMode?: MirrorMode | null;

  // UnifiedAnalysis 互換の構造（最低限使いそうな部分だけ）
  unified?:
    | {
        q?: { current?: string | null } | null;
        depth?: { stage?: string | null } | null;
        phase?: string | null;
        self_acceptance?: number | null;
        [key: string]: any;
      }
    | null;

  // 拡張用：トーン・関係性・キーワードなど
  relation_tone?: string | null;
  keywords?: string[];
  summary?: string | null;

  // 追加メタ（userCode / traceId / mode などを自由に入れる領域）
  extra?: Record<string, any> | null;

  // 将来の拡張に備えて、その他の予備フィールドも許容
  [key: string]: any;
};
