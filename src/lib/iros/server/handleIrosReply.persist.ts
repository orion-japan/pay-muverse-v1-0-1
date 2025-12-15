// file: src/lib/iros/server/handleIrosReply.persist.ts
// iros - Persist layer (minimal first, expand later)

import type { SupabaseClient } from '@supabase/supabase-js';

function toInt0to3(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(3, Math.round(v)));
}

export async function persistAssistantMessage(args: {
  supabase: SupabaseClient; // 使わないが、呼び出し側の統一のため受け取る
  reqOrigin: string;
  authorizationHeader: string | null;
  conversationId: string;
  userCode: string;
  assistantText: string;
  metaForSave: any;
}) {
  const {
    reqOrigin,
    authorizationHeader,
    conversationId,
    userCode,
    assistantText,
    metaForSave,
  } = args;

  try {
    const msgUrl = new URL('/api/agent/iros/messages', reqOrigin);

    // ★ writer を必ず一本化（skip判定の揺れを消す）
    // ★ さらに y/h は DB 保存と揃えるため整数に丸めて meta にも反映
    const yInt = toInt0to3(metaForSave?.yLevel ?? metaForSave?.unified?.yLevel);
    const hInt = toInt0to3(metaForSave?.hLevel ?? metaForSave?.unified?.hLevel);

    const meta = {
      ...(metaForSave ?? {}),
      writer: 'handleIrosReply',
      ...(yInt !== null ? { yLevel: yInt } : {}),
      ...(hInt !== null ? { hLevel: hInt } : {}),
    };

    await fetch(msgUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorizationHeader ?? '',
        'x-user-code': userCode,
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        role: 'assistant',
        text: assistantText,
        meta,
      }),
    });
  } catch (e) {
    console.error('[IROS/Persist] persistAssistantMessage failed', e);
  }
}

/**
 * Qコードスナップショット（既存の writeQCodeWithEnv に統一）
 */
export async function persistQCodeSnapshotIfAny(args: {
  userCode: string;
  conversationId: string;
  requestedMode: string | undefined;
  metaForSave: any;
}) {
  const { userCode, conversationId, requestedMode, metaForSave } = args;

  try {
    const m: any = metaForSave ?? null;
    const unified: any = m?.unified ?? null;

    const q: any = m?.qCode ?? m?.q_code ?? unified?.q?.current ?? null;
    const stage: any =
      m?.depth ?? m?.depth_stage ?? unified?.depth?.stage ?? null;

    const layer: any = 'inner';
    const polarity: any = 'now';

    if (q) {
      const { writeQCodeWithEnv } = await import('@/lib/qcode/qcode-adapter');

      await writeQCodeWithEnv({
        user_code: userCode,
        source_type: 'iros',
        intent: requestedMode ?? 'auto',
        q,
        stage,
        layer,
        polarity,
        conversation_id: conversationId,
        created_at: new Date().toISOString(),
        extra: { _from: 'handleIrosReply.persist' },
      });
    } else {
      console.warn('[IROS/Q] skip persistQCodeSnapshotIfAny because q is null');
    }
  } catch (e) {
    console.error('[IROS/Q] persistQCodeSnapshotIfAny failed', e);
  }
}

export async function persistIntentAnchorIfAny(_args: {
  supabase: SupabaseClient;
  userCode: string;
  metaForSave: any;
}) {
  // TODO: resolve user_id + upsertIntentAnchorForUser を移植する
}

export async function persistMemoryStateIfAny(args: {
  supabase: SupabaseClient;
  userCode: string;
  metaForSave: any;
}) {
  const { supabase, userCode, metaForSave } = args;

  try {
    if (!metaForSave) return;

    // unified を最優先で使う（postProcessReply 後は必ず揃っている）
    const unified: any = metaForSave.unified ?? {};

    const depth = metaForSave.depth ?? unified?.depth?.stage ?? null;
    const qCode = metaForSave.qCode ?? unified?.q?.current ?? null;
    const phase = metaForSave.phase ?? unified?.phase ?? null;

    const selfAcceptance =
      metaForSave.selfAcceptance ??
      unified?.selfAcceptance ??
      unified?.self_acceptance ??
      null;

    // ★ y/h は DB が integer なので、必ず 0..3 に丸めて整数化する
    const yInt = toInt0to3(metaForSave?.yLevel ?? unified?.yLevel);
    const hInt = toInt0to3(metaForSave?.hLevel ?? unified?.hLevel);

    // ★ 追加カラム（存在する前提：memoryState.ts と一致）
    const situationSummary =
      metaForSave.situationSummary ??
      unified?.situation?.summary ??
      metaForSave.situation_summary ??
      null;

    const situationTopic =
      metaForSave.situationTopic ??
      unified?.situation?.topic ??
      metaForSave.situation_topic ??
      null;

    const sentimentLevel =
      metaForSave.sentimentLevel ??
      metaForSave.sentiment_level ??
      unified?.sentiment_level ??
      null;

    console.log('[IROS/STATE] persistMemoryStateIfAny start', {
      userCode,
      yLevelRaw: metaForSave?.yLevel ?? unified?.yLevel ?? null,
      hLevelRaw: metaForSave?.hLevel ?? unified?.hLevel ?? null,
      yLevelInt: yInt,
      hLevelInt: hInt,
      depth,
      qCode,
    });

    // 保存する意味がある最低条件
    if (!depth && !qCode) {
      console.warn('[IROS/STATE] skip persistMemoryStateIfAny (no depth/q)', {
        userCode,
      });
      return;
    }

    const { error } = await supabase
      .from('iros_memory_state')
      .upsert(
        {
          user_code: userCode,
          depth_stage: depth,
          q_primary: qCode,
          phase,
          self_acceptance: selfAcceptance,
          y_level: yInt,
          h_level: hInt,
          sentiment_level: sentimentLevel,
          situation_summary: situationSummary,
          situation_topic: situationTopic,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_code' },
      );

    if (error) {
      console.error('[IROS/STATE] persistMemoryStateIfAny failed', {
        userCode,
        error,
      });
    } else {
      console.log('[IROS/STATE] persistMemoryStateIfAny ok', {
        userCode,
        depthStage: depth,
        qPrimary: qCode,
        phase,
        yLevel: yInt,
        hLevel: hInt,
      });
    }
  } catch (e) {
    console.error('[IROS/STATE] persistMemoryStateIfAny exception', {
      userCode,
      error: e,
    });
  }
}

export async function persistUnifiedAnalysisIfAny(_args: {
  supabase: SupabaseClient;
  userCode: string;
  tenantId: string;
  userText: string;
  assistantText: string;
  metaForSave: any;
  conversationId: string;
}) {
  // TODO: buildUnifiedAnalysis / saveUnifiedAnalysisInline / applyAnalysisToLastUserMessage を移植する
}
