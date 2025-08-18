import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// ---- Firebase Admin 初期化 ----
if (!getApps().length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (projectId && clientEmail && privateKey) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  } else {
    console.error('[create-thread-post] Firebase Admin env missing');
  }
}

// ---- Supabase (Service Role) ----
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // サーバー専用
);

export async function POST(req: Request) {
  // 1) Firebase ID トークン検証
  const authHeader = req.headers.get('authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  console.log('[create-thread-post] auth header:', !!idToken);
  if (!idToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    console.log('[create-thread-post] verified:', { uid: decoded.uid, email: decoded.email });

    // 2) リクエスト
    const body = await req.json().catch(() => ({}));
    const thread_id: string | undefined = body?.thread_id;
    const content: string | undefined = body?.content;
    const board_type: string = body?.board_type ?? 'self';
    if (!thread_id || !content) {
      return NextResponse.json({ error: 'Missing params' }, { status: 400 });
    }

    // 3) users から user_code を取得（email で紐づけ）
    let user_code: string | null = null;
    if (decoded.email) {
      const { data: urow } = await supabase
        .from('users')
        .select('user_code')
        .eq('email', decoded.email)
        .maybeSingle();
      user_code = urow?.user_code ?? null;
    }
    if (!user_code && body?.user_code) user_code = body.user_code; // フォールバック
    if (!user_code) {
      return NextResponse.json({ error: 'user_code not found' }, { status: 403 });
    }

    // 4) profiles から表示名・アイコン（レスポンスで合成するために取得）
    const { data: prof, error: pErr } = await supabase
      .from('profiles')
      .select('name, avatar_url')
      .eq('user_code', user_code)
      .maybeSingle();
    if (pErr) console.warn('[create-thread-post] profiles fetch warn:', pErr);

    // 5) posts に返信として挿入（postsに存在するカラムだけを保存）
    const insertRow = {
      thread_id,
      // parent_board はテーブルに無いので保存しない
      content,
      user_code,
      board_type,
      is_thread: false,
      media_urls: body?.media_urls ?? [],
    };
    console.log('[create-thread-post] insertRow:', insertRow);

    const { data: inserted, error: insErr } = await supabase
      .from('posts')
      .insert(insertRow)
      .select('post_id, content, created_at, user_code, media_urls')
      .single();

    if (insErr) {
      console.error('[create-thread-post] insert error:', insErr);
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    // 6) レスポンスにだけ表示用フィールドを合成して返却
    const enriched = {
      ...inserted,
      click_username: prof?.name ?? null,
      avatar_url: prof?.avatar_url ?? null,
    };

    console.log('[create-thread-post] insert OK, return enriched');
    return NextResponse.json(enriched, { status: 200 });
  } catch (e) {
    console.error('[create-thread-post] verify/insert error:', e);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
