// app/api/get-user-info/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { supabaseServer } from '@/lib/supabaseServer';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function J(status: number, body: any) {
  return NextResponse.json(body, { status });
}

async function getBearer(req: NextRequest): Promise<string | null> {
  const h = req.headers.get('authorization') || req.headers.get('Authorization');
  if (h?.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return null;
}

async function handle(req: NextRequest) {
  try {
    const idToken = await getBearer(req);
    if (!idToken) return J(401, { error: 'missing_token' });

    try {
      await adminAuth.verifyIdToken(idToken, true);
    } catch (e: any) {
      return J(401, { error: 'invalid_or_expired_token', detail: e?.code || String(e) });
    }

    const decoded = await adminAuth.verifyIdToken(idToken);
    const firebase_uid = decoded.uid;

    // まず users から基本情報
    const { data: u, error: e1 } = await supabaseServer
      .from('users')
      .select('user_code, click_username, click_type, sofia_credit')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle();

    if (e1) return J(500, { error: 'db_error', detail: e1.message });
    if (!u?.user_code) return J(404, { error: 'user_not_found' });

    // 次に profiles から avatar_url（無ければ null）
    let avatar_url: string | null = null;
    const { data: p, error: e2 } = await supabaseServer
      .from('profiles')
      .select('avatar_url')
      .eq('user_code', u.user_code)
      .maybeSingle();
    if (!e2 && p?.avatar_url) avatar_url = p.avatar_url;

    // フォールバック整形
    const user_code = u.user_code as string;
    const click_username = (u as any).click_username ?? user_code;
    const click_type = (u as any).click_type ?? 'free';
    const sofia_creditRaw = (u as any).sofia_credit;
    const sofia_credit =
      typeof sofia_creditRaw === 'number'
        ? sofia_creditRaw
        : Number.isFinite(Number(sofia_creditRaw))
          ? Number(sofia_creditRaw)
          : 0;

    const login_url = `https://m.muverse.jp?user_code=${user_code}`;

    // 返却（実アバターURLを追加）
    return J(200, {
      user_code,
      click_username,
      click_type,
      sofia_credit,
      avatar_url,
      login_url,
    });
  } catch (e: any) {
    return J(500, { error: 'server_error', detail: e?.message || String(e) });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
