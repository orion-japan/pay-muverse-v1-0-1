// src/app/api/get-user-info/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { supabaseAdmin as supabaseServer } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ====== ログ制御 ======
const DEBUG = process.env.DEBUG_LOCAL === 'true';
// ✅ ルートロード時に一度だけ（最低限のバナー）
console.log(
  `[api/get-user-info] route loaded. DEBUG_LOCAL=${process.env.DEBUG_LOCAL ?? '(unset)'}`
);
const dlog = (...args: any[]) => {
  if (DEBUG) console.log('[api/get-user-info]', ...args);
};
// レスポンスにデバッグ情報をヘッダで返す（本番では DEBUG=false 想定）
const withDebugHeaders = (res: NextResponse, meta: Record<string, any>) => {
  if (!DEBUG) return res;
  try {
    const json = JSON.stringify(meta);
    res.headers.set('x-debug', json.slice(0, 1024));
  } catch {}
  return res;
};

function J(status: number, body: any, meta?: Record<string, any>) {
  const res = NextResponse.json(body, { status });
  return withDebugHeaders(res, meta ?? {});
}

async function getBearer(req: NextRequest): Promise<string | null> {
  const h = req.headers.get('authorization') || req.headers.get('Authorization');
  if (h?.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return null;
}

async function handle(req: NextRequest) {
  // ✅ リクエスト毎に必ず出す（最小限）
  console.log('[api/get-user-info] request start');

  try {
    const idToken = await getBearer(req);
    if (!idToken) return J(401, { error: 'missing_token' }, { where: 'no_token' });

    // revoked チェックONで正規（切り分け時は /*, true*/ を外す）
    let decoded;
    try {
      decoded = await adminAuth.verifyIdToken(idToken, true);
    } catch (e: any) {
      dlog('verifyIdToken failed:', e?.code || e?.message);
      return J(
        401,
        { error: 'invalid_or_expired_token', detail: e?.code || String(e) },
        { where: 'verify_failed', code: e?.code || String(e) }
      );
    }
    const firebase_uid = decoded.uid as string;
    dlog('verified uid:', firebase_uid);

    // users
    const { data: u, error: e1 } = await supabaseServer
      .from('users')
      .select('user_code, click_username, click_type, sofia_credit')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle();

    dlog('users.select result:', { hasError: !!e1, hasUser: !!u?.user_code });

    if (e1) return J(500, { error: 'db_error', detail: e1.message }, { where: 'users_select_err', msg: e1.message });
    if (!u?.user_code) return J(404, { error: 'user_not_found' }, { where: 'no_user_row', uid: firebase_uid });

    // profiles（任意）
    let avatar_url: string | null = null;
    const { data: p, error: e2 } = await supabaseServer
      .from('profiles')
      .select('avatar_url')
      .eq('user_code', u.user_code)
      .maybeSingle();

    if (e2) dlog('profiles.select error:', e2.message);
    if (!e2 && p?.avatar_url) avatar_url = p.avatar_url;

    // 整形
    const user_code = u.user_code as string;
    const click_username = (u as any).click_username ?? user_code;
    const click_type = (u as any).click_type ?? 'free';
    const sofia_creditNum = Number((u as any).sofia_credit ?? 0);
    const sofia_credit = Number.isFinite(sofia_creditNum) ? sofia_creditNum : 0;
    const login_url = `https://m.muverse.jp?user_code=${user_code}`;

    const res = J(
      200,
      { user_code, click_username, click_type, sofia_credit, avatar_url, login_url },
      { where: 'ok', user_code, hasAvatar: !!avatar_url }
    );
    return res;
  } catch (e: any) {
    if (DEBUG) console.error('[api/get-user-info] ERROR:', e?.message || e);
    return J(500, { error: 'server_error', detail: e?.message || String(e) }, { where: 'catch', msg: e?.message || String(e) });
  } finally {
    console.log('[api/get-user-info] request end');
  }
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
