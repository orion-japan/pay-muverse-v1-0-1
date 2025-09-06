// src/app/api/q/unified/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, normalizeAuthz } from '@/lib/authz';

// ★ 追加：Q→色エネルギーのマッピング
import { mapQToColor } from '@/lib/sofia/qcolor';

export async function GET(req: NextRequest) {
  try {
    const authzRaw = await verifyFirebaseAndAuthorize(req);
    const { user, error } = normalizeAuthz(authzRaw);
    if (error || !user) {
      // ← ここで「Unauthorized」固定ではなく詳細メッセージを返す
      return NextResponse.json({ ok: false, error: String(error ?? 'Unauthorized') }, { status: 401 });
    }

    const userCode = req.nextUrl.searchParams.get('user_code') || user.user_code;
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

    const { data, error: qerr } = await supabase
      .from('v_user_q_unified2')
      .select('*')
      .eq('user_code', userCode)
      .maybeSingle();

    if (qerr) throw qerr;

    // ★ 追加：current_q から色エネルギーを付与（構造は維持し、data に q_color を1フィールド追加）
    const enriched = data
      ? { ...data, q_color: mapQToColor((data as any)?.current_q ?? undefined) }
      : data;

    const res = NextResponse.json({ ok: true, data: enriched });
    res.headers.set('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res;
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}
