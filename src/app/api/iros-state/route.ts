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

    // ① iros_memory_state（最新1件）
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
        timing.finished_at = nowIso();
        timing.total_ms = msSince(t0);
        return NextResponse.json({
          ok: true,
          source: 'iros_memory_state',
          user_code: userCode,
          state: ms[0],
          timing,
        });
      }
    }

    // ② fallback: iros_messages の最新 assistant meta
    {
      const q1 = process.hrtime.bigint();
      const { data: msg, error: msgErr } = await supabase
        .from('iros_messages')
        .select('id, created_at, role, meta, q_code, depth_stage, conversation_id')
        .eq('user_code', userCode)
        .order('created_at', { ascending: false })
        .limit(50);

      timing.supabase_ms.messages_ms = msSince(q1);

      if (msgErr) throw msgErr;

      const latestAssistant = (msg || []).find(
        (r: any) => r?.role === 'assistant' && r?.meta,
      );

      timing.finished_at = nowIso();
      timing.total_ms = msSince(t0);

      return NextResponse.json({
        ok: true,
        source: latestAssistant
          ? 'iros_messages.meta(latest assistant)'
          : 'none',
        user_code: userCode,
        state: latestAssistant ?? null,
        timing,
      });
    }
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
