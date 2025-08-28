// app/api/get-user-info/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { supabaseServer } from '@/lib/supabaseServer';

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

async function extractIdToken(req: NextRequest): Promise<string | null> {
  const authz = req.headers.get('authorization') || req.headers.get('Authorization');
  if (authz?.toLowerCase().startsWith('bearer ')) {
    return authz.slice(7).trim();
  }

  if (req.method === 'POST') {
    try {
      const body = await req.json().catch(() => ({}));
      const t = body?.idToken || body?.auth?.idToken;
      if (t && typeof t === 'string') return t;
    } catch {}
  }

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

    // Supabase: users から click_type を含めて取得
    const { data, error } = await supabaseServer
      .from('users')
      .select('user_code, click_type')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle();

    if (error || !data?.user_code) {
      return json(404, { error: 'ユーザーが見つかりません' });
    }

    // login_url と一緒に click_type も返却
    const login_url = `https://m.muverse.jp?user_code=${data.user_code}`;
    return json(200, {
      user_code: data.user_code,
      click_type: data.click_type,
      login_url,
    });
  } catch (err: any) {
    console.error('[get-user-info] error:', err);
    return json(500, { error: err?.message || 'サーバーエラー' });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
