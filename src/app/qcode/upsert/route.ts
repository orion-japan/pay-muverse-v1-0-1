// src/app/api/qcode/upsert/route.ts
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY!; // server-only

export async function POST(req: NextRequest) {
  const supabase = createClient(url, service, { auth: { persistSession: false } });
  const { user_code, s_ratio=0, r_ratio=0, c_ratio=0, i_ratio=0, si_balance=0, traits = {} } = await req.json();

  if (!user_code) return NextResponse.json({ error: 'missing user_code' }, { status: 400 });

  const payload = {
    user_code,
    s_ratio, r_ratio, c_ratio, i_ratio, si_balance,
    traits,
    updated_at: new Date().toISOString(),
  };

  // upsert
  const { error: upErr } = await supabase
    .from('user_q_codes')
    .upsert(payload, { onConflict: 'user_code' });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  // log
  await supabase.from('q_code_logs').insert({
    user_code,
    source: 'manual',
    snapshot: payload,
  });

  return NextResponse.json({ ok: true });
}
