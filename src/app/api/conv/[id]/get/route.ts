export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  verifyFirebaseAndAuthorize,
  SUPABASE_URL,
  SERVICE_ROLE,
} from '@/lib/authz';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const z = await verifyFirebaseAndAuthorize(req);
  if (!z.ok || !z.userCode) {
    return NextResponse.json({ error: z.error }, { status: z.status });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // 会話ヘッダ（自分のものだけ）
  const { data: conv, error: e1 } = await sb
    .from('conversations')
    .select('id, user_code, title, updated_at')
    .eq('id', params.id)
    .eq('user_code', z.userCode)   // ★ 所有者チェック
    .maybeSingle();

  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });
  if (!conv) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // メッセージ（自分の分だけ）
  const { data: msgs, error: e2 } = await sb
    .from('messages')
    .select('role, content, created_at')
    .eq('conversation_id', params.id)
    .eq('user_code', z.userCode)   // ★ 念のため絞る
    .order('created_at', { ascending: true });

  if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });

  return NextResponse.json({
    conversation: conv,
    messages: msgs ?? [],
  });
}
