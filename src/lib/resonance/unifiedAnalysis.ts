// file: src/lib/resonance/unifiedAnalysis.ts

export type UnifiedAnalysis = {
  q_code: string | null;
  depth_stage: string | null;
  phase: string | null;
  self_acceptance: number | null;
  relation_tone: string | null;
  keywords: string[];
  summary: string | null;
  raw: any;
};

/**
 * Orchestrator の meta とテキストから UnifiedAnalysis を組み立てる
 */
export function buildUnifiedAnalysis(args: {
  userText: string;
  assistantText: string;
  meta: any;
}): UnifiedAnalysis {
  const { userText, assistantText, meta } = args ?? {};

  const safeAssistant = typeof assistantText === 'string' ? assistantText : '';
  const safeMeta = meta ?? {};

  return {
    q_code: safeMeta.qCode ?? safeMeta.q_code ?? null,
    depth_stage: safeMeta.depth ?? safeMeta.depth_stage ?? null,
    phase: safeMeta.phase ?? null,
    self_acceptance:
      typeof safeMeta.self_acceptance === 'number'
        ? safeMeta.self_acceptance
        : null,
    relation_tone: safeMeta.relation_tone ?? null,
    keywords: Array.isArray(safeMeta.keywords) ? safeMeta.keywords : [],
    summary:
      typeof safeMeta.summary === 'string' && safeMeta.summary.trim().length > 0
        ? safeMeta.summary
        : safeAssistant
        ? safeAssistant.slice(0, 60)
        : null,
    raw: {
      user_text: userText,
      assistant_text: safeAssistant,
      meta: safeMeta,
    },
  };
}
