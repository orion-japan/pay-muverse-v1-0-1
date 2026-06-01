import { normalizeDiagnosisTargetKey } from './normalizeDiagnosisTargetKey';

export type SaveIrDiagnosisResultPayload = {
  ownerUserCode: string;
  conversationId?: string | null;
  messageId?: number | string | null;

  targetLabel: string | null;

  drawSeed?: string | null;
  drawSource?: string | null;
  drawPickKey?: string | null;
  drawPickJson?: any | null;

  qPrimary?: string | null;
  depthStage?: string | null;
  phase?: string | null;
  intentAnchorKey?: string | null;
  itxStep?: string | null;

  diagnosisText: string;
  diagnosisJson?: any | null;
};

function normalizeNullableString(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s.length > 0 ? s : null;
}

function normalizeNullableBigInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  const n = Number(value);
  if (!Number.isFinite(n)) return null;

  return Math.trunc(n);
}

export async function saveIrDiagnosisResult(
  supabase: any,
  payload: SaveIrDiagnosisResultPayload,
): Promise<{ ok: boolean; id: number | null; error?: unknown }> {
  const ownerUserCode = normalizeNullableString(payload.ownerUserCode);
  const targetLabel = normalizeNullableString(payload.targetLabel);
  const diagnosisText = String(payload.diagnosisText ?? '').trim();

  if (!ownerUserCode || !targetLabel || !diagnosisText) {
    if (process.env.DEBUG_IROS_MEMORY === '1') {
      console.warn('[IROS/IrDiagnosisResult] skip: missing required fields', {
        ownerUserCode,
        targetLabel,
        diagnosisTextLen: diagnosisText.length,
      });
    }

    return { ok: false, id: null };
  }

  const targetKey = normalizeDiagnosisTargetKey(targetLabel);

  const row = {
    owner_user_code: ownerUserCode,
    conversation_id: normalizeNullableString(payload.conversationId),
    message_id: normalizeNullableBigInt(payload.messageId),

    target_label: targetLabel,
    target_key: targetKey,

    draw_seed: normalizeNullableString(payload.drawSeed),
    draw_source: normalizeNullableString(payload.drawSource),
    draw_pick_key: normalizeNullableString(payload.drawPickKey),
    draw_pick_json: payload.drawPickJson ?? null,

    q_primary: normalizeNullableString(payload.qPrimary),
    depth_stage: normalizeNullableString(payload.depthStage),
    phase: normalizeNullableString(payload.phase),
    intent_anchor_key: normalizeNullableString(payload.intentAnchorKey),
    itx_step: normalizeNullableString(payload.itxStep),

    diagnosis_text: diagnosisText,
    diagnosis_json: payload.diagnosisJson ?? null,
  };

  const { data, error } = await supabase
    .from('iros_ir_diagnosis_results')
    .insert(row)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[IROS/IrDiagnosisResult] insert error', {
      error,
      ownerUserCode,
      targetLabel,
      targetKey,
    });

    return { ok: false, id: null, error };
  }

  if (process.env.DEBUG_IROS_MEMORY === '1') {
    console.log('[IROS/IrDiagnosisResult] insert ok', {
      id: data?.id ?? null,
      ownerUserCode,
      targetLabel,
      targetKey,
    });
  }

  return {
    ok: true,
    id: typeof data?.id === 'number' ? data.id : null,
  };
}
