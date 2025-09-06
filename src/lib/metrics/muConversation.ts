// src/lib/metrics/muConversation.ts
// Mu 会話メトリクス定義とヘルパー

import { MU_KPI } from "@/lib/mu/config";

export type MuMetricRecord = {
  key: string;
  value: number;
  at: string; // ISO
  conversation_id?: string;
  user_code?: string;
};

/** KPI ラベル */
export const MU_METRIC_LABELS: Record<string, string> = {
  [MU_KPI.INTENT_TO_AGREEMENT_TURNS_AVG]: "意図→合意 平均ターン数",
  [MU_KPI.IMAGE_FAIL_RATE]: "画像生成失敗率",
  [MU_KPI.IMAGE_FALLBACK_RATE]: "画像生成フォールバック率",
  [MU_KPI.IMAGE_LATENCY_MS_AVG]: "画像生成平均時間(ms)",
  [MU_KPI.USER_FDBK_INTENT_UNDERSTOOD]: "ユーザー意図理解率",
};

/** メトリクス記録ペイロード生成 */
export function makeMuMetric(
  key: string,
  value: number,
  conversation_id?: string,
  user_code?: string
): MuMetricRecord {
  return {
    key,
    value,
    at: new Date().toISOString(),
    conversation_id,
    user_code,
  };
}

/** 簡易集計: 平均値を計算 */
export function avg(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 簡易集計: 割合をパーセント表示 */
export function percent(n: number, d: number): string {
  if (d === 0) return "0%";
  return `${((n / d) * 100).toFixed(1)}%`;
}
