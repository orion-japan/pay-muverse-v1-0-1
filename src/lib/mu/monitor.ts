// src/lib/mu/monitor.ts
// Mu の運用監視・状態チェックヘルパー

import {
    recordIntentAgreementTurns,
    recordImageFailRate,
    recordImageFallbackRate,
    recordImageLatency,
    recordUserIntentFeedback,
  } from "./telemetry";
  import { MuMetricRecord } from "@/lib/metrics/muConversation";
  
  export type ConversationStats = {
    conversation_id: string;
    user_code?: string;
    turnsToAgreement?: number;
    imageFails?: number;
    imageTotal?: number;
    imageFallbacks?: number;
    imageLatencies?: number[];
    fbkPositive?: number;
    fbkTotal?: number;
  };
  
  /**
   * 会話統計から Mu のメトリクスをまとめて生成
   */
  export function buildMuMetrics(stats: ConversationStats): MuMetricRecord[] {
    const out: MuMetricRecord[] = [];
  
    if (typeof stats.turnsToAgreement === "number") {
      out.push(
        recordIntentAgreementTurns(stats.turnsToAgreement, stats.conversation_id, stats.user_code)
      );
    }
    if (
      typeof stats.imageFails === "number" &&
      typeof stats.imageTotal === "number"
    ) {
      out.push(recordImageFailRate(stats.imageFails, stats.imageTotal, stats.conversation_id));
    }
    if (
      typeof stats.imageFallbacks === "number" &&
      typeof stats.imageTotal === "number"
    ) {
      out.push(recordImageFallbackRate(stats.imageFallbacks, stats.imageTotal, stats.conversation_id));
    }
    if (Array.isArray(stats.imageLatencies) && stats.imageLatencies.length > 0) {
      out.push(recordImageLatency(stats.imageLatencies, stats.conversation_id));
    }
    if (
      typeof stats.fbkPositive === "number" &&
      typeof stats.fbkTotal === "number"
    ) {
      out.push(
        recordUserIntentFeedback(stats.fbkPositive, stats.fbkTotal, stats.conversation_id)
      );
    }
  
    return out;
  }
  