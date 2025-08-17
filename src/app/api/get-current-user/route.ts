// src/app/api/get-current-user/route.ts
import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import { adminAuth } from '@/lib/firebase-admin'; // Firebase Admin SDK: admin.auth()

export async function POST(req: Request) {
  console.log('========== [get-current-user] API開始 ==========');

  try {
    // ① まず Supabase のセッション(Cookie)で取得（既存の動作）
    const {
      data: { user },
      error,
    } = await supabaseServer.auth.getUser();

    if (!error && user) {
      console.log('[get-current-user] ✅ Supabaseセッションで取得成功:', user.id);
      return NextResponse.json({ user_code: user.id }, { status: 200 });
    }

    // ② Supabaseから取れない場合は Firebase の idToken でフォールバック
    const authz = req.headers.get('authorization') || '';
    let idToken = '';

    if (authz.startsWith('Bearer ')) {
      idToken = authz.slice('Bearer '.length).trim();
    } else {
      // body からの受け取りにも対応（後方互換）
      const body = await req.json().catch(() => ({} as any));
      if (body?.idToken) idToken = String(body.idToken);
    }

    if (!idToken) {
      console.warn('[get-current-user] ⚠️ トークン不在（Authorization も body.idToken も無し）');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Firebase トークン検証
    const decoded = await adminAuth.verifyIdToken(idToken).catch((e) => {
      console.error('[get-current-user] ❌ Firebase verifyIdToken 失敗:', e);
      return null;
    });
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const uid = decoded.uid;
    const email = decoded.email ?? null;
    console.log('[get-current-user] 🔑 Firebase認証成功 uid:', uid, 'email:', email);

    // ③ users テーブルから user_code を引く（uid 優先、なければ email フォールバック）
    //   ※ スキーマに合わせて列名は調整してください（例: uid カラムが無い場合は user_id など）
    const { data: userRowByUid, error: uerr1 } = await supabaseServer
      .from('users')
      .select('user_code')
      .eq('uid', uid)           // ← uid カラムを使う想定
      .maybeSingle();

    let userCode: string | null = userRowByUid?.user_code ?? null;

    if (!userCode && email) {
      const { data: userRowByEmail, error: uerr2 } = await supabaseServer
        .from('users')
        .select('user_code')
        .eq('email', email)     // ← email フォールバック
        .maybeSingle();

      if (uerr1) console.warn('[get-current-user] users(uid) 取得警告:', uerr1);
      if (uerr2) console.warn('[get-current-user] users(email) 取得警告:', uerr2);

      userCode = userRowByEmail?.user_code ?? null;
    }

    if (!userCode) {
      console.warn('[get-current-user] ⚠️ user_code 見つからず (uid/email 不一致)');
      return NextResponse.json({ error: 'user_code not found' }, { status: 404 });
    }

    console.log('[get-current-user] ✅ user_code 返却:', userCode);
    return NextResponse.json({ user_code: userCode }, { status: 200 });
  } catch (err: any) {
    console.error('[get-current-user] ❌ 予期せぬエラー', err?.message ?? err);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
