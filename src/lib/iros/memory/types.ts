// src/lib/iros/memory/types.ts
// Qコードまわりの共通型定義
// - QSnapshot / QTrace / IrosMemory … Iros の軽量メモリ
// - Phase / Depth / ResonanceMetrics / RetrievalBundle … 将来の検索・分析用

// ====================== 基本ラベル ======================

export type Phase = 'Inner' | 'Outer';

/**
 * Qコードレポートで使う 18 段階＋T層の深度ラベル。
 * （S/F/R/C/I/T の詳細は PDF を参照）
 */
export type Depth =
  | 'S1' | 'S2' | 'S3' | 'S4'
  | 'R1' | 'R2' | 'R3'
  | 'C1' | 'C2' | 'C3'
  | 'I1' | 'I2' | 'I3'
  | 'T1' | 'T2' | 'T3';

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

// ====================== QTrace 系の型 ======================

/**
 * user_q_now から切り出した「現在の状態」のスナップショット。
 */
export type QSnapshot = {
  currentQ: QCode | null;    // いま優勢な Q（なければ null）
  depthStage: string | null; // S1〜I3 などの深度ラベル（未設定可）
  updatedAt: string | null;  // 最終更新時刻（ISO文字列／未設定可）
};

/**
 * Qコードの履歴 + 集計。
 * - counts      : Q1〜Q5 のヒストグラム
 * - streakQ     : 直近で連続している Q（なければ null）
 * - streakLength: その連続長
 * - lastEventAt : q_code_timeline の直近イベント時刻
 */
export type QTrace = {
  snapshot: QSnapshot;
  counts: Partial<Record<QCode, number>>;
  streakQ: QCode | null;
  streakLength: number;
  lastEventAt: string | null;
};

/**
 * Iros が扱う最小限のメモリ単位。
 * - userCode : アプリ側で使っている user_code
 * - qTrace   : Qコードの状態と履歴
 *
 * ＋ Sofia 型「構造OS」のコア記憶（その人の芯）
 */
export type IrosMemory = {
  userCode: string;
  qTrace: QTrace;

  /**
   * その人の最も中心にある「意図軸」（例：「安心」「創造」「貢献」「自由」など）。
   * すべての揺れの根にある “根源的な願い”。
   */
  coreIntent?: string | null;

  /**
   * 長期にわたって繰り返し現れる人生テーマ。
   * 例）「境界線の揺れ」「責任と自由の葛藤」「自己価値の模索」
   */
  longTermTheme?: string | null;

  /**
   * 人との関係において現れやすい “構図の癖”。
   * 例）「調整役になりがち」「受け取りすぎる」「支配−服従のループ」
   */
  relationshipPattern?: string | null;

  /**
   * Qコード／深度の傾向。（どこが落ちやすい／どこで開きやすいか）
   * 例）「Q3が優勢」「I2→I3 に行きやすい」「C層で停滞しやすい」
   */
  energyPattern?: string | null;

  /**
   * その人らしい言語トーンや、反応の仕方の特徴。
   * 例）「静かに深く考える」「未来志向」「内省が速い」など。
   */
  identityTone?: string | null;
};

// ====================== 共鳴メトリクス ======================

export type ResonanceMetrics = {
  phase?: Phase;
  depth?: Depth;
  q_primary?: QCode;
  q_secondary?: QCode;
  polarity_avg?: number;        // -1.0〜+1.0 の平均
  self_acceptance_avg?: number; // 0〜1
};

// ====================== 検索／エビデンス用 ======================

export type RootIds = {
  userId: string;         // uuid
  conversationId: string; // uuid
};

export type EvidenceCard = {
  id: string;             // episode id or "st-context"
  title?: string;
  date?: string;          // ISO
  snippet: string;        // 抜粋
  trust?: number;
};

export type RetrievalBundle = {
  miniSummary: string;       // 直近要約（ST-Context）
  objectiveLine: string;     // 目的一句
  evidences: EvidenceCard[]; // 根拠カード（最大3〜5）
  metrics: ResonanceMetrics; // 共鳴指標サマリ
};
