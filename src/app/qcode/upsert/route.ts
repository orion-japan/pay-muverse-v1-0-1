// src/app/api/qcode/upsert/route.ts
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { writeQCodeWithEnv } from '@/lib/qcode/qcode-adapter';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY!; // server-only

export async function POST(req: NextRequest) {
  const supabase = createClient(url, service, { auth: { persistSession: false } });

  const {
    user_code,
    s_ratio = 0,
    r_ratio = 0,
    c_ratio = 0,
    i_ratio = 0,
    si_balance = 0,
    traits = {},
    // 任意：クライアントが送れるなら拾う（なくてもOK）
    q, // 'Q1'..'Q5'
    stage, // 'S1'.. など
    intent, // 'manual' など
  } = await req.json().catch(() => ({}));

  if (!user_code) return NextResponse.json({ error: 'missing user_code' }, { status: 400 });

  const payload = {
    user_code: String(user_code),
    s_ratio,
    r_ratio,
    c_ratio,
    i_ratio,
    si_balance,
    traits,
    updated_at: new Date().toISOString(),
  };

  // 1) user_q_codes はこのAPIの本務なので upsert 継続
  const { error: upErr } = await supabase.from('user_q_codes').upsert(payload, {
    onConflict: 'user_code',
  });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  // 2) ログは q_code_logs 直INSERTをやめ、統一入口(writeQCode)へ
  //    CHECK制約(currentQ/depthStage)を満たすため、q/stage が無ければ安全デフォルトに落とす
  try {
    await writeQCodeWithEnv({
      user_code: String(user_code),
      source_type: 'env',
      intent: String(intent || 'system'),

      q: (q === 'Q1' || q === 'Q2' || q === 'Q3' || q === 'Q4' || q === 'Q5') ? q : 'Q1',
      stage: (stage === 'S2' || stage === 'S3') ? stage : 'S1',
      layer: 'inner',
      polarity: 'now',

      conversation_id: null,
      post_id: null,
      title: 'user_q_codes upsert',
      note: null,

      created_at: new Date().toISOString(),
      extra: {
        _from: 'api/qcode/upsert',
        kind: 'user_q_codes_snapshot',
        snapshot: payload, // ← これが元の "snapshot: payload" の置き場
      },
    });
  } catch (e: any) {
    // upsert自体は成功してるので、ログ失敗は落とさず warn
    console.warn('[api/qcode/upsert] writeQCode warn:', e?.message ?? e);
  }

  return NextResponse.json({ ok: true });
}
