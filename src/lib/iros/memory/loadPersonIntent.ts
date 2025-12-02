// src/lib/iros/memory/loadPersonIntent.ts
import type { SupabaseClient } from '@supabase/supabase-js';

export type PersonIntentStateRecord = {
  ownerUserCode: string;
  targetType: string;
  targetLabel: string;

  qPrimary: string | null;
  depthStage: string | null;
  phase: string | null;

  intentBand: string | null;
  direction: string | null;
  focusLayer: string | null;
  coreNeed: string | null;
  guidanceHint: string | null;

  tLayerHint: string | null;
  selfAcceptance: number | null;

  updatedAt: string | null;
};

/**
 * iros_person_intent_state から 1件取得するヘルパー。
 * - 見つからない場合は null を返す
 * - ここでは DB からの値をそのまま素直にマッピングするだけにしておく
 */
export async function loadPersonIntentState(
  supabase: SupabaseClient,
  params: {
    ownerUserCode: string;
    targetType: string;
    targetLabel: string;
  },
): Promise<PersonIntentStateRecord | null> {
  const { ownerUserCode, targetType, targetLabel } = params;

  if (!ownerUserCode || !targetType || !targetLabel) {
    if (process.env.DEBUG_IROS_INTENT === '1') {
      console.warn('[IROS/PersonIntentState] load skip: missing key fields', {
        ownerUserCode,
        targetType,
        targetLabel,
      });
    }
    return null;
  }

  const { data, error } = await supabase
    .from('iros_person_intent_state')
    .select('*')
    .eq('owner_user_code', ownerUserCode)
    .eq('target_type', targetType)
    .eq('target_label', targetLabel)
    .maybeSingle();

  if (error) {
    console.error('[IROS/PersonIntentState] load error', error);
    return null;
  }

  if (!data) {
    if (process.env.DEBUG_IROS_INTENT === '1') {
      console.log('[IROS/PersonIntentState] no record', {
        ownerUserCode,
        targetType,
        targetLabel,
      });
    }
    return null;
  }

  return {
    ownerUserCode: data.owner_user_code,
    targetType: data.target_type,
    targetLabel: data.target_label,

    qPrimary: data.q_primary ?? null,
    depthStage: data.depth_stage ?? null,
    phase: data.phase ?? null,

    intentBand: data.intent_band ?? null,
    direction: data.direction ?? null,
    focusLayer: data.focus_layer ?? null,
    coreNeed: data.core_need ?? null,
    guidanceHint: data.guidance_hint ?? null,

    tLayerHint: data.t_layer_hint ?? null,
    selfAcceptance: data.self_acceptance ?? null,

    updatedAt: data.updated_at ?? null,
  };
}
