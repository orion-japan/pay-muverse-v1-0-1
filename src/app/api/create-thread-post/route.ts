// src/app/api/create-thread-post/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

/* -------------------------- Firebase Admin 初期化 -------------------------- */
// 既存の構造は維持しつつ、credential 解決だけ堅くします
function cleanupPK(v: string) {
  return v.replace(/\\n/g, '\n').replace(/^\s*"|"\s*$/g, '');
}
function resolveServiceAccount() {
  // プロジェクトIDは NEXT_PUBLIC/FIREBASE のどちらでも可
  const projectId =
    process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

  // ① 推奨: 3 変数直指定
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKeyRaw) {
    return { projectId, clientEmail, privateKey: cleanupPK(privateKeyRaw) };
  }

  // ② JSON 文字列でもOK
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (json) {
    try {
      const obj = JSON.parse(json);
      return {
        projectId: obj.project_id,
        clientEmail: obj.client_email,
        privateKey: cleanupPK(String(obj.private_key || '')),
      };
    } catch (e) {
      console.warn('[create-thread-post] Invalid FIREBASE_SERVICE_ACCOUNT_KEY JSON:', e);
    }
  }

  // ③ BASE64 でもOK
  const b64 = process.env.FIREBASE_ADMIN_KEY_BASE64;
  if (b64) {
    try {
      const obj = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      return {
        projectId: obj.project_id,
        clientEmail: obj.client_email,
        privateKey: cleanupPK(String(obj.private_key || '')),
      };
    } catch (e) {
      console.warn('[create-thread-post] Invalid FIREBASE_ADMIN_KEY_BASE64:', e);
    }
  }

  return null;
}

if (!getApps().length) {
  const cred = resolveServiceAccount();
  if (cred) {
    initializeApp({ credential: cert(cred) });
  } else {
    console.error('[create-thread-post] Firebase Admin env missing');
  }
}

/* ---------------------------- Supabase (SRK) ------------------------------- */
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // サーバー専用
);

/* ---------------------------------- POST ---------------------------------- */
export async function POST(req: Request) {
  // 1) Firebase ID トークン検証
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const decoded = await getAuth().verifyIdToken(idToken);

    // 2) 入力
    const body = await req.json().catch(() => ({}));
    const thread_id: string | undefined = body?.thread_id;
    const content: string | undefined = body?.content;
    const board_type: string = body?.board_type ?? 'self';
    if (!thread_id || !content) {
      return NextResponse.json({ error: 'Missing params' }, { status: 400 });
    }

    // 3) users から user_code を取得（email 優先、なければ body の user_code を使用）
    let user_code: string | null = null;
    if (decoded.email) {
      const { data: urow, error: uerr } = await supabase
        .from('users')
        .select('user_code')
        .eq('email', decoded.email)
        .maybeSingle();
      if (uerr) console.warn('[create-thread-post] users fetch warn:', uerr);
      user_code = urow?.user_code ?? null;
    }
    if (!user_code && body?.user_code) user_code = String(body.user_code);
    if (!user_code) {
      return NextResponse.json({ error: 'user_code not found' }, { status: 403 });
    }

    // 4) profiles（表示名/アイコンをレスポンス合成用に取得）
    const { data: prof, error: pErr } = await supabase
      .from('profiles')
      .select('name, avatar_url')
      .eq('user_code', user_code)
      .maybeSingle();
    if (pErr) console.warn('[create-thread-post] profiles fetch warn:', pErr);

    // 5) posts に返信として挿入（※posts テーブルに存在するカラムのみ）
    const insertRow = {
      thread_id,           // スキーマが thread_id 方式
      content,
      user_code,
      board_type,
      is_thread: false,    // スキーマにある想定（無ければ削除）
      media_urls: body?.media_urls ?? [],
    };

    const { data: inserted, error: insErr } = await supabase
      .from('posts')
      .insert(insertRow)
      .select('post_id, content, created_at, user_code, media_urls')
      .single();

    if (insErr) {
      console.error('[create-thread-post] insert error:', insErr);
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    // 6) 表示用フィールドを合成して返却
    const enriched = {
      ...inserted,
      click_username: prof?.name ?? null,
      avatar_url: prof?.avatar_url ?? null,
    };

    return NextResponse.json(enriched, { status: 200 });
  } catch (e) {
    console.error('[create-thread-post] verify/insert error:', e);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
