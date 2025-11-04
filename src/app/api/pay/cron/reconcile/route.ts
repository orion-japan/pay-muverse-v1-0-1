import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const nowIso = new Date().toISOString();

  // 有効期限が過去なのに plan_status が pro の人を free に戻す
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('user_code, plan_status, plan_valid_until')
    .neq('plan_status', 'free')
    .not('plan_valid_until', 'is', null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const targets = (data || []).filter(
    (u) => u.plan_valid_until && new Date(u.plan_valid_until) < new Date(nowIso),
  );

  for (const u of targets) {
    await supabaseAdmin.from('users').update({ plan_status: 'free' }).eq('user_code', u.user_code);
  }

  return NextResponse.json({ ok: true, checked: data?.length || 0, expired: targets.length });
}
