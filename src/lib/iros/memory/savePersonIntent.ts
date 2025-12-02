// src/lib/iros/memory/savePersonIntent.ts
import { createClient } from '@supabase/supabase-js';

/**
 * iros_person_intent_state に 1行 upsert するためのペイロード。
 * ここでは型をかなり素直に「文字列／数値」に寄せておき、
 * Iros 側の型（IntentLineAnalysis など）とのマッピングは
 * 呼び出し側で行う想定にしています。
 */
export type PersonIntentStatePayload = {
  ownerUserCode: string;
  targetType: string;
  targetLabel: string;

  qPrimary?: string | null;
  depthStage?: string | null;
  phase?: string | null; // 'Inner' | 'Outer' | null などを想定

  intentBand?: string | null;
  direction?: string | null;
  focusLayer?: string | null;
  coreNeed?: string | null;
  guidanceHint?: string | null;

  tLayerHint?: string | null;

  selfAcceptance?: number | null;
};

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SERVICE_ROLE_KEY!;

// サーバー専用のサービスロールクライアント
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

/**
 * iros_person_intent_state への upsert を行うヘルパー。
 * - ownerUserCode / targetType / targetLabel が揃っていない場合は何もしない
 * - 失敗しても Iros 本体の挙動は止めない（ログだけ出す）
 */
export async function savePersonIntentState(
  payload: PersonIntentStatePayload,
): Promise<void> {
  const {
    ownerUserCode,
    targetType,
    targetLabel,
    qPrimary,
    depthStage,
    phase,
    intentBand,
    direction,
    focusLayer,
    coreNeed,
    guidanceHint,
    tLayerHint,
    selfAcceptance,
  } = payload;

  // 必須が欠けている場合はスキップ（静かに無視）
  if (!ownerUserCode || !targetType || !targetLabel) {
    if (process.env.DEBUG_IROS_INTENT === '1') {
      console.warn('[IROS/PersonIntentState] skip: missing key fields', {
        ownerUserCode,
        targetType,
        targetLabel,
      });
    }
    return;
  }

  const { error } = await supabase
    .from('iros_person_intent_state')
    .upsert(
      {
        owner_user_code: ownerUserCode,
        target_type: targetType,
        target_label: targetLabel,

        q_primary: qPrimary ?? null,
        depth_stage: depthStage ?? null,
        phase: phase ?? null,

        intent_band: intentBand ?? null,
        direction: direction ?? null,
        focus_layer: focusLayer ?? null,
        core_need: coreNeed ?? null,
        guidance_hint: guidanceHint ?? null,

        t_layer_hint: tLayerHint ?? null,
        self_acceptance: selfAcceptance ?? null,

        updated_at: new Date().toISOString(),
      },
      {
        onConflict: 'owner_user_code,target_type,target_label',
      },
    );

  if (error) {
    // ここで本体処理を止めたくないので throw はしない
    console.error('[IROS/PersonIntentState] upsert error', error);
  } else if (process.env.DEBUG_IROS_INTENT === '1') {
    console.log('[IROS/PersonIntentState] upsert ok', {
      ownerUserCode,
      targetType,
      targetLabel,
    });
  }
}
