// src/app/api/ops/user-search/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ✗ const URL = ...
// 変数名がグローバル URL を潰すので使わない
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPA_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Service Role でサーバー側から読む（RLSを安全に通過）
const supabase = createClient(SUPA_URL, SUPA_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// GET /api/ops/user-search?q=foo&limit=20
export async function GET(req: NextRequest) {
  try {
    // ✅ ここがポイント：req.nextUrl から searchParams を取る
    const searchParams = req.nextUrl.searchParams;
    const q = (searchParams.get('q') || '').trim();
    const limit = Math.min(Number(searchParams.get('limit') || '20'), 50);

    if (!q) {
      return NextResponse.json({ ok: true, items: [] }, { status: 200 });
    }

    // ユーザーコードっぽいか？（数値 or U-XXXXXX）
    const isUserCodeLike = /^\d+$/.test(q) || /^U-[A-Z0-9]+$/i.test(q);

    let items: Array<{ user_code: string; name: string }> = [];

    if (isUserCodeLike) {
      // user_code 直接一致
      const { data, error } = await supabase
        .from('profiles') // ←環境のテーブル名に合わせて
        .select('user_code, display_name, full_name, username')
        .eq('user_code', q)
        .limit(limit);

      if (error) throw error;
      items = (data || []).map((r: any) => ({
        user_code: String(r.user_code),
        name: String(r.display_name || r.full_name || r.username || r.user_code),
      }));
    } else {
      // 名前で部分一致（display_name / full_name / username）
      const { data, error } = await supabase
        .from('profiles') // ←環境のテーブル名に合わせて
        .select('user_code, display_name, full_name, username, updated_at')
        .or(`display_name.ilike.%${q}%,full_name.ilike.%${q}%,username.ilike.%${q}%`)
        .order('updated_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      items = (data || []).map((r: any) => ({
        user_code: String(r.user_code),
        name: String(r.display_name || r.full_name || r.username || r.user_code),
      }));
    }

    return NextResponse.json({ ok: true, items }, { status: 200 });
  } catch (err: any) {
    console.error('[user-search] error', err);
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}
