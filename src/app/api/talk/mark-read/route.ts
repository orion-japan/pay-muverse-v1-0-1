// app/api/talk/mark-read/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { conversation_id } = await req.json();
    if (!conversation_id) {
      return NextResponse.json({ error: 'bad request' }, { status: 400 });
    }

    // Firebaseトークン→本人
    const authz = req.headers.get('authorization') || '';
    const token = authz.toLowerCase().startsWith('bearer ')
      ? authz.slice(7).trim()
      : '';
    const decoded = token ? await adminAuth.verifyIdToken(token).catch(() => null) : null;
    if (!decoded) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    // uid -> user_code
    const { data: userRow } = await supabase
      .from('users')
      .select('user_code')
      .eq('uid', decoded.uid)
      .maybeSingle();

    const me = userRow?.user_code;
    if (!me) {
      return NextResponse.json({ error: 'user not found' }, { status: 400 });
    }

    // 既読更新（RPC: mark_read）
    const { error } = await supabase.rpc('mark_read', {
      p_conversation_id: conversation_id,
      me,
    });

    if (error) throw error;

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: any) {
    console.error('[Talk][mark-read]', e);
    return NextResponse.json({ error: e?.message || 'unexpected' }, { status: 500 });
  }
}
