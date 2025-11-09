import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const sb = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const headers = new Headers();
  headers.set('x-handler', 'app/api/credits/inspect');

  try {
    const url = new URL(req.url);
    const ref = url.searchParams.get('ref') ?? '';
    const user = url.searchParams.get('user') ?? '';
    const limit = Number(url.searchParams.get('limit') ?? 20);

    const s = sb();

    let q = s.from('credits_ledger')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    // 条件合成：ref / idempotency_key / user_code
    // ref 指定があれば ref=... または idempotency_key=... の OR
    if (ref) {
      // PostgRESTは or クエリをクエリ文字列で書くのが一般的だが、
      // SDKでも eq を2つ付けられないため、RPC経由 or ビュー経由が堅い。
      // ここでは簡易にビュー v_credits_ledger_refkey を推奨：
      //   SELECT *, COALESCE(idempotency_key, ref) AS refkey FROM credits_ledger;
      // それを使って refkey=ref で一本化する。
      const { data, error } = await s
        .from('v_credits_ledger_refkey')
        .select('*')
        .eq('refkey', ref)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return NextResponse.json({ ok: true, error: null, rows: data ?? [] }, { headers });
    }

    // user 指定があれば user_code で絞る
    if (user) q = q.eq('user_code', user);

    const { data, error } = await q;
    if (error) throw error;

    return NextResponse.json({ ok: true, error: null, rows: data ?? [] }, { headers });
  } catch (e: any) {
    return new NextResponse(JSON.stringify({ ok: false, error: e?.message ?? 'inspect_failed' }), {
      status: 500,
      headers,
    });
  }
}
