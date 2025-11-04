import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

if (!getApps().length) initializeApp();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const target = url.searchParams.get('target'); // 見られているユーザー（フォローされる側）
    const me = url.searchParams.get('me'); // クライアントが渡す自分の user_code（任意）

    if (!target) {
      return NextResponse.json({ error: 'target required' }, { status: 400 });
    }

    let followerCode = me ?? undefined;

    // 🔒 認証トークンから自分の user_code を取得（fallback）
    const authHeader = req.headers.get('authorization');
    if (!followerCode && authHeader) {
      const token = authHeader.replace('Bearer ', '');
      const decoded = await getAuth().verifyIdToken(token);
      followerCode = (decoded as any)?.user_code as string | undefined;
    }

    if (!followerCode) {
      // 非ログイン or 自分の情報が取れない場合は未フォロー扱い
      return NextResponse.json({ isFollowing: false });
    }

    // 👀 フォロー状態チェック（ship_typeは無視、任意のフォローがあればtrue）
    const { count, error } = await supabase
      .from('follows')
      .select('*', { head: true, count: 'exact' })
      .eq('follower_code', followerCode)
      .eq('following_code', target);

    if (error) throw error;

    return NextResponse.json({ isFollowing: (count ?? 0) > 0 });
  } catch (e: any) {
    console.error('[check-follow] error', e);
    return NextResponse.json({ error: e?.message ?? 'unknown error' }, { status: 500 });
  }
}
