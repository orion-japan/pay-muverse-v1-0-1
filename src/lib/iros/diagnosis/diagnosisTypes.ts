// src/lib/iros/diagnosis/diagnosisTypes.ts
// iros — ir diagnosis OS (types)
// 方針：既存の meta / slots の型に依存しない（境界で吸収）

export type DiagnosisPhase = 'Inner' | 'Outer' | string;
export type DiagnosisDepthStage = string; // 例: S1..T3 / C2 / R3 など
export type QCode = string; // 例: Q1..Q5 など

export type DiagnosisMetaLike = {
  qPrimary?: QCode | null;
  depthStage?: DiagnosisDepthStage | null;
  phase?: DiagnosisPhase | null;
  intentLayer?: string | null; // S/R/C/I/T など
  intentAnchor?: string | null; // SUN など
  itxStep?: string | null; // T3 など
  situationSummary?: string | null;
  situationTopic?: string | null;

  // 実装揺れを許容（unified / intent_anchor など）
  unified?: any;
  intent_anchor?: any;
  extra?: any;
  [k: string]: any;
};

export type DiagnosisSlotLike = {
  key?: string;
  text?: string;
  content?: string;
  label?: string;
  [k: string]: any;
};

export type DiagnosisInput = {
  // “診断対象” の文字（例: 自分 / ともちゃん など）
  targetLabel: string;

  // 現在の meta（MemoryState を含む想定だが型固定しない）
  meta: DiagnosisMetaLike;

  // slotPlan から来る slots（存在しない場合もある）
  slots?: DiagnosisSlotLike[] | null;

  // 任意（ログ/トレース）
  traceId?: string | null;
  conversationId?: string | null;
  userCode?: string | null;
};

export type DiagnosisOutput =
  | {
      ok: true;
      text: string; // commit 可能な最終診断文
      head: string; // ログ用短い見出し
      debug?: Record<string, any>;
    }
  | {
      ok: false;
      reason: string;
      debug?: Record<string, any>;
    };
