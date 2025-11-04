import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabaseClient';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  console.log('========== [resonance/toggle] START ==========');
  try {
    const { postId, resonanceType, qCode } = await req.json();

    // 実装：あなたの AuthContext / Middleware で userCode を渡す
    // ここではヘッダ経由の仮実装
    const userCode = req.headers.get('x-user-code') ?? '';

    if (!postId || !resonanceType || !userCode) {
      console.error('[❌ invalid params]', { postId, resonanceType, userCode });
      return NextResponse.json({ error: 'invalid params' }, { status: 400 });
    }

    // 既存確認
    const { data: existing, error: selErr } = await supabase
      .from('post_resonances')
      .select('resonance_id')
      .eq('post_id', postId)
      .eq('user_code', userCode)
      .eq('resonance_type', resonanceType)
      .maybeSingle();

    if (selErr) throw selErr;

    if (existing) {
      // 取り消し
      const { error: delErr } = await supabase
        .from('post_resonances')
        .delete()
        .eq('resonance_id', existing.resonance_id);
      if (delErr) throw delErr;
    } else {
      // 追加
      const payload = {
        post_id: postId,
        user_code: userCode,
        resonance_type: resonanceType,
        q_code: qCode ?? {},
      };
      const { error: insErr } = await supabase.from('post_resonances').insert(payload);
      if (insErr) throw insErr;
    }

    // 最新カウント（種類別）
    const { data: allRows, error: allErr } = await supabase
      .from('post_resonances')
      .select('resonance_type')
      .eq('post_id', postId);

    if (allErr) throw allErr;

    const counts: Record<string, number> = {};
    for (const r of allRows ?? []) {
      counts[r.resonance_type] = (counts[r.resonance_type] ?? 0) + 1;
    }

    return NextResponse.json({ ok: true, counts });
  } catch (e: any) {
    console.error('[❌ resonance/toggle]', e);
    return NextResponse.json({ error: e?.message ?? 'server error' }, { status: 500 });
  }
}
