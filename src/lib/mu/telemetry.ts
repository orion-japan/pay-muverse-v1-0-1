// src/lib/mu/telemetry.ts
// Mu 用テレメトリ送信ヘルパー

import { makeMuMetric, MuMetricRecord } from '@/lib/metrics/muConversation';
import { MU_KPI } from '@/lib/mu/config';

/**
 * 意図→合意ターン数を記録
 */
export function recordIntentAgreementTurns(
  turns: number,
  conversation_id?: string,
  user_code?: string,
): MuMetricRecord {
  return makeMuMetric(MU_KPI.INTENT_TO_AGREEMENT_TURNS_AVG, turns, conversation_id, user_code);
}

/**
 * 画像生成失敗率を記録
 */
export function recordImageFailRate(
  fails: number,
  total: number,
  conversation_id?: string,
): MuMetricRecord {
  const value = total > 0 ? (fails / total) * 100 : 0;
  return makeMuMetric(MU_KPI.IMAGE_FAIL_RATE, value, conversation_id);
}

/**
 * 画像フォールバック率を記録
 */
export function recordImageFallbackRate(
  fallbacks: number,
  total: number,
  conversation_id?: string,
): MuMetricRecord {
  const value = total > 0 ? (fallbacks / total) * 100 : 0;
  return makeMuMetric(MU_KPI.IMAGE_FALLBACK_RATE, value, conversation_id);
}

/**
 * 画像生成平均時間を記録 (ms)
 */
export function recordImageLatency(latencies: number[], conversation_id?: string): MuMetricRecord {
  const avg = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  return makeMuMetric(MU_KPI.IMAGE_LATENCY_MS_AVG, avg, conversation_id);
}

/**
 * 「意図が伝わった」ユーザーフィードバック率を記録
 */
export function recordUserIntentFeedback(
  positive: number,
  total: number,
  conversation_id?: string,
): MuMetricRecord {
  const value = total > 0 ? (positive / total) * 100 : 0;
  return makeMuMetric(MU_KPI.USER_FDBK_INTENT_UNDERSTOOD, value, conversation_id);
}
