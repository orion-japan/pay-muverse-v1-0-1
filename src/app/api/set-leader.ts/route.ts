// src/app/api/set-leader/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // 管理権限
);

export async function POST(req: Request) {
  try {
    const { leader_user_code, origin_user_code, group_code, created_by } = await req.json();

    if (!leader_user_code || !origin_user_code || !group_code) {
      return NextResponse.json({ error: '必須パラメータが不足しています' }, { status: 400 });
    }

    // 1. origin_user_code の tier_level を取得
    const { data: origin, error: originError } = await supabase
      .from('leader_history')
      .select('tier_level')
      .eq('leader_user_code', origin_user_code)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (originError && originError.code !== 'PGRST116') {
      throw originError;
    }

    // 派生元がなければ tier=1（起点リーダー）
    const newTier = origin ? origin.tier_level + 1 : 1;

    // 2. leader_history に記録
    const { error: insertError } = await supabase.from('leader_history').insert({
      leader_user_code,
      origin_user_code,
      group_code,
      tier_level: newTier,
      created_by,
    });
    if (insertError) throw insertError;

    // 3. users テーブルにリーダーフラグを立てる
    const { error: updateError } = await supabase
      .from('users')
      .update({ is_leader: true })
      .eq('user_code', leader_user_code);
    if (updateError) throw updateError;

    return NextResponse.json({
      success: true,
      leader_user_code,
      tier_level: newTier,
    });
  } catch (err: any) {
    console.error('Error in set-leader:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
