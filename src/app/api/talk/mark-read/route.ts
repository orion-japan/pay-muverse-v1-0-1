// /app/api/talk/mark-read/route.ts
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
    // どのキーでも受ける（conversation_id / thread_id / threadId）
    const body = await req.json().catch(() => ({} as any));
    const convId: string | undefined =
      body?.conversation_id ?? body?.thread_id ?? body?.threadId ?? undefined;

    // ID 無しは 400 → 監視ループが止まらないように 200 で返したい場合は下の return に差し替え
    if (!convId) {
      // return NextResponse.json({ ok: true, conversation_id: null }, { status: 200 });
      return NextResponse.json({ error: 'bad request' }, { status: 400 });
    }

    // ソフト認証：Authorization があれば検証、無ければスキップして 200 を返す
    const authz = req.headers.get('authorization') || '';
    const token = authz.toLowerCase().startsWith('bearer ')
      ? authz.slice(7).trim()
      : '';
    let user_code: string | null = null;

    if (token) {
      const decoded = await adminAuth.verifyIdToken(token).catch(() => null);
      if (decoded) {
        const { data: userRow, error: uerr } = await supabase
          .from('users')
          .select('user_code')
          .eq('uid', decoded.uid)
          .maybeSingle();
        if (uerr) throw uerr;
        user_code = userRow?.user_code ?? null;
      }
    }

    // 認証が通ったときだけ DB を更新（通らなくても 200 を返す）
    if (user_code) {
      const { error } = await supabase.rpc('mark_read', {
        p_conversation_id: convId,
        me: user_code,
      });
      if (error) {
        // DB 失敗はログのみ、応答は 200 維持（ポーリングを止めない）
        console.warn('[Talk][mark-read] rpc error:', error);
      }
    }

    return NextResponse.json({ ok: true, conversation_id: convId }, { status: 200 });
  } catch (e: any) {
    console.error('[Talk][mark-read]', e);
    // 例外でも監視を止めない方針にするなら 200 にしてもOK
    return NextResponse.json({ error: e?.message || 'unexpected' }, { status: 500 });
  }
}
