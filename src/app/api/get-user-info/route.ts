// app/api/get-user-info/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { supabaseServer } from '@/lib/supabaseServer';

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

/** どこに来てもOK: Authorization / POST body / GET query から idToken を抽出 */
async function extractIdToken(req: NextRequest): Promise<string | null> {
  // 1) Authorization: Bearer <token>
  const authz = req.headers.get('authorization') || req.headers.get('Authorization');
  if (authz?.toLowerCase().startsWith('bearer ')) {
    const t = authz.slice(7).trim();
    if (t) return t;
  }

  // 2) POST body: { idToken } or { auth: { idToken } }
  if (req.method === 'POST') {
    try {
      const body = await req.json().catch(() => ({}));
      const t = body?.idToken || body?.auth?.idToken;
      if (t && typeof t === 'string') return t;
    } catch {
      // ignore
    }
  }

  // 3) GET query: ?idToken=...
  const q = new URL(req.url).searchParams.get('idToken');
  if (q) return q;

  return null;
}

async function handle(req: NextRequest) {
  try {
    const idToken = await extractIdToken(req);
    if (!idToken) return json(400, { error: 'idToken is required' });

    // Firebase トークン検証
    const decoded = await adminAuth.verifyIdToken(idToken, true);
    const firebase_uid = decoded.uid;

    // Supabase: users から user_code を取得
    const { data, error } = await supabaseServer
      .from('users')
      .select('user_code')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle();

    if (error || !data?.user_code) {
      return json(404, { error: 'ユーザーが見つかりません' });
    }

    // 返却する login_url（用途に応じて変更可）
    const login_url = `https://m.muverse.jp?user_code=${data.user_code}`;
    return json(200, { login_url });
  } catch (err: any) {
    console.error('[get-user-info] error:', err);
    return json(500, { error: err?.message || 'サーバーエラー' });
  }
}

// ★ GET/POST 両対応
export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
