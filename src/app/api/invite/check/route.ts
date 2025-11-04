import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const BASE_CREDIT = 45;

export async function POST(req: NextRequest) {
  try {
    const { eve, user_code } = await req.json();

    if (!eve) {
      return NextResponse.json({ ok: true, credit: BASE_CREDIT });
    }

    // 招待コードの検証
    const { data: inv, error } = await supabaseAdmin
      .from('invite_codes')
      .select('id, code, is_active, expires_at, max_uses, used_count, bonus_credit')
      .eq('code', eve)
      .maybeSingle();

    if (error) throw error;

    if (
      !inv ||
      !inv.is_active ||
      (inv.expires_at && new Date(inv.expires_at) <= new Date()) ||
      (inv.max_uses && (inv.used_count ?? 0) >= inv.max_uses)
    ) {
      // 無効なコード
      return NextResponse.json({ ok: true, credit: BASE_CREDIT });
    }

    const bonus = inv.bonus_credit ?? 0;
    const credit = BASE_CREDIT + bonus;

    // 使用ログを保存（オプション）
    if (user_code) {
      await supabaseAdmin.from('invite_uses').insert({
        invite_id: inv.id,
        user_code,
      });
      // used_count をインクリメント
      await supabaseAdmin
        .from('invite_codes')
        .update({ used_count: (inv.used_count ?? 0) + 1 })
        .eq('id', inv.id);
    }

    return NextResponse.json({ ok: true, credit, bonus });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
