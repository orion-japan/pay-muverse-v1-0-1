// src/app/api/iros-state/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Timing = {
  started_at: string;
  finished_at: string;
  total_ms: number;
  supabase_ms: {
    memory_state_ms: number;
    messages_ms: number;
  };
};

function nowIso() {
  return new Date().toISOString();
}

function msSince(startNs: bigint): number {
  const diff = process.hrtime.bigint() - startNs;
  return Number(diff) / 1_000_000;
}

// -----------------------------
// ✅ debug_snapshot は “軽量化して安全形” にする
// - 循環参照/巨大payloadを返さない
// - state(正)とは別物（debug再現用）
// -----------------------------
function pickDebugMeta(meta: any) {
  const m = meta ?? {};
  const extra = m?.extra ?? {};
  const llmGate = extra?.llmGate ?? null;
  const renderV2 = extra?.renderV2 ?? null;

  // 返して良い “最小” の debug meta だけ
  return {
    q: typeof m?.q === 'string' ? m.q : null,
    qCode: typeof m?.qCode === 'string' ? m.qCode : null,
    q_code: typeof m?.q_code === 'string' ? m.q_code : null,

    depth: typeof m?.depth === 'string' ? m.depth : null,
    depth_stage: typeof m?.depth_stage === 'string' ? m.depth_stage : null,

    phase: typeof m?.phase === 'string' ? m.phase : null,
    mode: typeof m?.mode === 'string' ? m.mode : null,
    frame: typeof m?.frame === 'string' ? m.frame : null,
    style: typeof m?.style === 'string' ? m.style : null,

    // ✅ 事故りやすい slotPlan / framePlan / unified 等は “返さない”
    // ✅ 必要な再現キーだけ返す
    extra: {
      uiMode: typeof extra?.uiMode === 'string' ? extra.uiMode : null,
      llmEntry: typeof extra?.llmEntry === 'string' ? extra.llmEntry : null,
      llmSkipReason: typeof extra?.llmSkipReason === 'string' ? extra.llmSkipReason : null,
      persistPolicy: typeof extra?.persistPolicy === 'string' ? extra.persistPolicy : null,
      finalTextPolicy: typeof extra?.finalTextPolicy === 'string' ? extra.finalTextPolicy : null,
      slotPlanPolicy_detected:
        typeof extra?.slotPlanPolicy_detected === 'string' ? extra.slotPlanPolicy_detected : null,
      slotPlanCommitted: typeof extra?.slotPlanCommitted === 'boolean' ? extra.slotPlanCommitted : null,

      // LLM Gate / Render v2 のダイジェストだけ
      llmGate: llmGate
        ? {
            at: typeof llmGate?.at === 'string' ? llmGate.at : null,
            llmEntry: typeof llmGate?.llmEntry === 'string' ? llmGate.llmEntry : null,
            hasSlots: typeof llmGate?.hasSlots === 'boolean' ? llmGate.hasSlots : null,
            slotPlanLen: typeof llmGate?.slotPlanLen === 'number' ? llmGate.slotPlanLen : null,
            slotPlanPolicy: typeof llmGate?.slotPlanPolicy === 'string' ? llmGate.slotPlanPolicy : null,
            allowLLM_final: typeof llmGate?.allowLLM_final === 'boolean' ? llmGate.allowLLM_final : null,
            finalAssistantTextLen:
              typeof llmGate?.finalAssistantTextLen === 'number' ? llmGate.finalAssistantTextLen : null,
            finalAssistantTextHead:
              typeof llmGate?.finalAssistantTextHead === 'string' ? llmGate.finalAssistantTextHead : null,
            finalAssistantTextCandidateLen:
              typeof llmGate?.finalAssistantTextCandidateLen === 'number'
                ? llmGate.finalAssistantTextCandidateLen
                : null,
            finalAssistantTextCandidateHead:
              typeof llmGate?.finalAssistantTextCandidateHead === 'string'
                ? llmGate.finalAssistantTextCandidateHead
                : null,
          }
        : null,

      renderV2: renderV2
        ? {
            enable: typeof renderV2?.enable === 'boolean' ? renderV2.enable : null,
            outLen: typeof renderV2?.outLen === 'number' ? renderV2.outLen : null,
            outHead: typeof renderV2?.outHead === 'string' ? renderV2.outHead : null,
            blocksCount: typeof renderV2?.blocksCount === 'number' ? renderV2.blocksCount : null,
            pickedFrom: typeof renderV2?.pickedFrom === 'string' ? renderV2.pickedFrom : null,
            pickedLen: typeof renderV2?.pickedLen === 'number' ? renderV2.pickedLen : null,
            pickedHead: typeof renderV2?.pickedHead === 'string' ? renderV2.pickedHead : null,
          }
        : null,
    },
  };
}

function buildDebugSnapshotRow(row: any) {
  if (!row) return null;
  return {
    id: row?.id ?? null,
    created_at: row?.created_at ?? null,
    role: row?.role ?? null,
    conversation_id: row?.conversation_id ?? null,
    user_code: row?.user_code ?? null,
    q_code: row?.q_code ?? null,
    depth_stage: row?.depth_stage ?? null,
    meta: pickDebugMeta(row?.meta),
  };
}

export async function GET(req: NextRequest) {
  const t0 = process.hrtime.bigint();
  const startedAt = nowIso();

  // timing を常に返す（失敗時も）
  const timing: Timing = {
    started_at: startedAt,
    finished_at: startedAt,
    total_ms: 0,
    supabase_ms: {
      memory_state_ms: 0,
      messages_ms: 0,
    },
  };

  try {
    const { searchParams } = new URL(req.url);
    const userCode = (searchParams.get('user_code') || '').trim();

    if (!userCode) {
      timing.finished_at = nowIso();
      timing.total_ms = msSince(t0);
      return NextResponse.json(
        { ok: false, error: 'Missing query: user_code', timing },
        { status: 400 },
      );
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { auth: { persistSession: false } },
    );

    // -----------------------------
    // ✅ state（authoritative）
    // - 正は iros_memory_state のみ
    // -----------------------------
    let authoritativeState: any = null;

    {
      const q0 = process.hrtime.bigint();
      const { data: ms, error: msErr } = await supabase
        .from('iros_memory_state')
        .select('*')
        .eq('user_code', userCode)
        .order('updated_at', { ascending: false })
        .limit(1);

      timing.supabase_ms.memory_state_ms = msSince(q0);

      if (!msErr && ms && ms.length > 0) {
        authoritativeState = ms[0];
      }
    }

    // -----------------------------
    // ✅ debug_snapshot（non-authoritative）
    // - iros_messages.meta は debug snapshot として返す（軽量化）
    // - state の計算/継続の正として採用しない
    // -----------------------------
    let debugSnapshot: any = null;

    {
      const q1 = process.hrtime.bigint();
      const { data: msg, error: msgErr } = await supabase
        .from('iros_messages')
        .select('id, created_at, role, meta, q_code, depth_stage, conversation_id, user_code')
        .eq('user_code', userCode)
        .order('created_at', { ascending: false })
        .limit(50);

      timing.supabase_ms.messages_ms = msSince(q1);

      if (msgErr) throw msgErr;

      const latestAssistant = (msg || []).find(
        (r: any) => r?.role === 'assistant' && r?.meta,
      );

      debugSnapshot = latestAssistant ? buildDebugSnapshotRow(latestAssistant) : null;
    }

    // -----------------------------
    // ✅ 返却ポリシー
    // - state: authoritative のみ（無ければ null）
    // - debug_snapshot: debug 用（無ければ null）
    // -----------------------------
    const source = authoritativeState
      ? 'iros_memory_state(authoritative)'
      : debugSnapshot
        ? 'iros_messages.debug_snapshot(latest assistant)'
        : 'none';

    timing.finished_at = nowIso();
    timing.total_ms = msSince(t0);

    return NextResponse.json({
      ok: true,
      source,
      user_code: userCode,
      state: authoritativeState,
      debug_snapshot: debugSnapshot,
      timing,
    });
  } catch (e: any) {
    console.error('[iros-state] error', e);

    timing.finished_at = nowIso();
    timing.total_ms = msSince(t0);

    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e), timing },
      { status: 500 },
    );
  }
}
