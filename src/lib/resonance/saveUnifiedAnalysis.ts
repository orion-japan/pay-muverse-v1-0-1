// file: src/lib/resonance/saveUnifiedAnalysis.ts

import { createClient } from '@supabase/supabase-js';
import type { UnifiedAnalysis } from './unifiedAnalysis';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error('[saveUnifiedAnalysis] NEXT_PUBLIC_SUPABASE_URL is not set');
}
if (!serviceRoleKey) {
  throw new Error('[saveUnifiedAnalysis] SUPABASE_SERVICE_ROLE_KEY is not set');
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

/**
 * UnifiedAnalysis を
 * - unified_resonance_logs に INSERT
 * - user_resonance_state を UPSERT
 */
export async function saveUnifiedAnalysis(
  analysis: UnifiedAnalysis,
  context: {
    userCode: string;
    tenantId: string;
    agent: string; // 'iros' | 'sofia' | 'mui' | ...
  },
) {
  // --- 1) ログ保存 ---
  const { error: logErr } = await supabase
    .from('unified_resonance_logs')
    .insert({
      tenant_id: context.tenantId,
      user_code: context.userCode,
      agent: context.agent,
      q_code: analysis.q_code,
      depth_stage: analysis.depth_stage,
      phase: analysis.phase,
      self_acceptance: analysis.self_acceptance,
      relation_tone: analysis.relation_tone,
      keywords: analysis.keywords,
      summary: analysis.summary,
      raw: analysis.raw,
    });

  if (logErr) {
    console.error('[saveUnifiedAnalysis] log insert failed', logErr);
    throw new Error(`log insert failed: ${logErr.message}`);
  }

  // --- 2) state 更新 ---
  const { data: prev, error: prevErr } = await supabase
    .from('user_resonance_state')
    .select('*')
    .eq('user_code', context.userCode)
    .eq('tenant_id', context.tenantId)
    .maybeSingle();

  if (prevErr) {
    console.error('[saveUnifiedAnalysis] state load failed', prevErr);
    throw new Error(`state load failed: ${prevErr.message}`);
  }

  const isSameQ = prev?.last_q === analysis.q_code;
  const streak = isSameQ ? (prev?.streak_count ?? 0) + 1 : 1;

  const { error: stateErr } = await supabase
    .from('user_resonance_state')
    .upsert({
      user_code: context.userCode,
      tenant_id: context.tenantId,
      last_q: analysis.q_code,
      last_depth: analysis.depth_stage,
      last_phase: analysis.phase,
      last_self_acceptance: analysis.self_acceptance,
      streak_q: analysis.q_code,
      streak_count: streak,
      updated_at: new Date().toISOString(),
    });

  if (stateErr) {
    console.error('[saveUnifiedAnalysis] state upsert failed', stateErr);
    throw new Error(`state upsert failed: ${stateErr.message}`);
  }
}
