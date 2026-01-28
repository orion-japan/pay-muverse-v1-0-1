// src/lib/iros/diagnosis/diagnosisEngine.ts
// iros — ir diagnosis OS (engine)
// 目的：入力（meta/slots/target）を受けて「診断文（commit可能）」を返す。
// 方針：LLMなし / 既存のrephrase/llmGate/renderに依存しない。

import type { DiagnosisInput, DiagnosisOutput } from './diagnosisTypes';
import { buildDiagnosisText } from './buildDiagnosisText';

export function diagnosisEngine(input: DiagnosisInput): DiagnosisOutput {
  try {
    const targetLabel = String(input?.targetLabel ?? '').trim() || '対象';
    const meta = (input?.meta ?? {}) as any;
    const slots = (input?.slots ?? null) as any;

    // ✅ アクセス証明ログ（この3ファイルに実際に入っているか確認用）
    console.warn('[IROS/DIAG][ENGINE_USED]', {
      targetLabel,
      hasSlots: Array.isArray(slots) ? slots.length : slots ? 1 : 0,
      qPrimary: meta?.qPrimary ?? meta?.unified?.qPrimary ?? null,
      depthStage: meta?.depthStage ?? meta?.unified?.depthStage ?? null,
      phase: meta?.phase ?? meta?.unified?.phase ?? null,
      conversationId: input?.conversationId ?? null,
      userCode: input?.userCode ?? null,
      traceId: input?.traceId ?? null,
    });

    const built = buildDiagnosisText({ targetLabel, meta, slots });

    return {
      ok: true,
      text: built.text,
      head: built.head,
      debug: {
        ...built.debug,
        conversationId: input?.conversationId ?? null,
        userCode: input?.userCode ?? null,
        traceId: input?.traceId ?? null,
      },
    };
  } catch (e: any) {
    return {
      ok: false,
      reason: 'DIAGNOSIS_ENGINE_FAILED',
      debug: {
        message: String(e?.message ?? e ?? ''),
      },
    };
  }
}
