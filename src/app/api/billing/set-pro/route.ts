export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies as nhCookies } from 'next/headers';

/** 必須envを安全に読み出す */
function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
const SB_URL = mustEnv('NEXT_PUBLIC_SUPABASE_URL');
const SRVKEY = mustEnv('SUPABASE_SERVICE_ROLE_KEY');

/** JSONレスポンス */
function json(data: any, status = 200) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * Cookieから mu_user_code を取得（環境差による sync/async 双方に対応）
 * 1) req.cookies（常に同期）
 * 2) next/headers の cookies()（sync/async の両方にフォールバック）
 */
async function readMuUserCode(req: NextRequest): Promise<string | null> {
  // 1) Request の Cookie
  const v1 = req.cookies.get('mu_user_code')?.value?.trim();
  if (v1) return v1;

  // 2) next/headers の cookies()
  try {
    // 型的には関数。環境によっては Promise を返すことがある
    const cOrPromise = nhCookies as unknown as () => any;
    let store = cOrPromise();
    if (store && typeof store.then === 'function') {
      store = await store; // Promise の場合は await
    }
    const v2 = store?.get?.('mu_user_code')?.value?.trim?.();
    if (v2) return v2;
  } catch {
    /* noop */
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    // user_code 解決：Cookie → ヘッダ → クエリ
    const user_code =
      (await readMuUserCode(req)) ||
      req.headers.get('x-mu-user')?.trim() ||
      req.nextUrl.searchParams.get('user_code')?.trim() ||
      null;

    if (!user_code) {
      return json({ ok: false, error: '未ログイン（user_codeなし）' }, 401);
    }

    // Supabase 更新
    const sb = createClient(SB_URL, SRVKEY, { auth: { persistSession: false } });
    const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30日有効

    const { error } = await sb
      .from('users')
      .update({ plan_status: 'pro', plan_until: until })
      .eq('user_code', user_code);

    if (error) return json({ ok: false, error: error.message }, 500);

    return json({ ok: true, user_code, plan_status: 'pro', plan_until: until }, 200);
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
