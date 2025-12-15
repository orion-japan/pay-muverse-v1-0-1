// src/app/api/iros-state/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userCode = (searchParams.get('user_code') || '').trim();

    if (!userCode) {
      return NextResponse.json(
        { ok: false, error: 'Missing query: user_code' },
        { status: 400 },
      );
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { auth: { persistSession: false } },
    );

    // ① まず「現在状態テーブル」から拾う（※あなたの環境のテーブル名に合わせてください）
    // 想定: iros_memory_state に user_code / state_json / updated_at 等がある
    // ここは "存在しない場合" でも落ちないように try/fallback します
    const { data: ms, error: msErr } = await supabase
      .from('iros_memory_state')
      .select('*')
      .eq('user_code', userCode)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (!msErr && ms && ms.length > 0) {
      return NextResponse.json({ ok: true, source: 'iros_memory_state', state: ms[0] });
    }

    // ② fallback: iros_messages の最新 assistant meta を拾う（stateテーブルが無くても表示できる）
    const { data: msg, error: msgErr } = await supabase
      .from('iros_messages')
      .select('id, created_at, role, meta, q_code, depth_stage')
      .eq('user_code', userCode)
      .order('created_at', { ascending: false })
      .limit(20);

    if (msgErr) throw msgErr;

    const latestAssistant = (msg || []).find((r: any) => r.role === 'assistant' && r.meta);

    return NextResponse.json({
      ok: true,
      source: latestAssistant ? 'iros_messages.meta(latest assistant)' : 'none',
      state: latestAssistant ?? null,
    });
  } catch (e: any) {
    console.error('[iros-state] error', e);
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 },
    );
  }
}
