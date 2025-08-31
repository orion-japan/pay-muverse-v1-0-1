export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  verifyFirebaseAndAuthorize,
  SUPABASE_URL,
  SERVICE_ROLE,
} from '@/lib/authz';

export async function GET(req: NextRequest) {
  // 認証（master/admin 以外は 403）
  const z = await verifyFirebaseAndAuthorize(req);
  if (!z.ok || !z.userCode) {
    return NextResponse.json({ error: z.error }, { status: z.status });
  }

  // Service Role で作成（Authorization に pgJwt は付けない）
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // 自分の user_code だけを確実に取得
  const { data, error } = await sb
    .from('conversations')
    .select('id, title, updated_at')
    .eq('user_code', z.userCode)       // ★ ここで明示フィルタ
    .order('updated_at', { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ items: data ?? [] });
}
