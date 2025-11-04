// /src/app/api/register/consume-invite/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { user_code, invite_code } = body ?? {};

    if (!user_code || !invite_code) {
      return NextResponse.json(
        { ok: false, error: 'missing: user_code or invite_code' },
        { status: 400 },
      );
    }

    // 1) 招待コードを原子的に消費
    const { data: redeemed, error: rpcErr } = await supabaseAdmin.rpc('redeem_invite', {
      p_code: invite_code,
    });

    if (rpcErr) {
      return NextResponse.json(
        { ok: false, error: `redeem failed: ${rpcErr.message}` },
        { status: 400 },
      );
    }

    // 2) ユーザーへ反映
    const updatePayload: any = {
      inviter_user_code: redeemed.creator_user_code,
      ref_code: redeemed.code,
    };
    if (redeemed.group_id) updatePayload.group_id = redeemed.group_id;

    {
      const { error } = await supabaseAdmin
        .from('users')
        .update(updatePayload)
        .eq('user_code', user_code);
      if (error) throw new Error(`users update failed: ${error.message}`);
    }

    // 3) グループ参加（あれば）
    if (redeemed.group_id) {
      const { error } = await supabaseAdmin.from('group_members').upsert({
        group_id: redeemed.group_id,
        user_code,
        role: 'member',
      });
      if (error) throw new Error(`group_members upsert failed: ${error.message}`);
    }

    return NextResponse.json({
      ok: true,
      invite: {
        code: redeemed.code,
        creator_user_code: redeemed.creator_user_code,
        group_id: redeemed.group_id,
        max_uses: redeemed.max_uses,
        used_count: redeemed.used_count,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'unknown error' }, { status: 500 });
  }
}
