export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

async function uidToUserCode(uid: string) {
  // firebase_uid 優先、なければ旧 uid
  const a = await sb.from('users').select('user_code').eq('firebase_uid', uid).maybeSingle();
  if (a.data?.user_code) return String(a.data.user_code);
  const b = await sb.from('users').select('user_code').eq('uid', uid).maybeSingle();
  return b.data?.user_code ? String(b.data.user_code) : null;
}

export async function GET(req: NextRequest) {
  try {
    // 1) 開発フォールバック: ヘッダ X-User-Code または ?me= で直接指定可
    const url = new URL(req.url);
    const meHeader = req.headers.get('x-user-code')?.trim() || '';
    const meQuery = url.searchParams.get('me')?.trim() || '';

    // 2) 本命: Authorization: Bearer <idToken>
    const authz = req.headers.get('authorization') || '';
    const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : '';

    let me: string | null = null;

    if (token) {
      const decoded = await adminAuth.verifyIdToken(token).catch(() => null);
      if (decoded?.uid) me = await uidToUserCode(decoded.uid);
    }

    // Bearer で取れなかったら開発用フォールバックを使う
    if (!me) me = meHeader || meQuery || null;

    if (!me) {
      // 誰かわからなければ 0 を返す（ポーリングは止めない）
      return NextResponse.json(
        { unread: 0 },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // 集計は関数一本化
    const { data, error } = await sb.rpc('unread_total_sum_v3', { me });
    if (error) {
      console.warn('[unread-count] rpc error', error);
      return NextResponse.json(
        { unread: 0 },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const unread = Number(data ?? 0);
    return NextResponse.json(
      { unread: Number.isFinite(unread) ? unread : 0 },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    console.error('[unread-count] GET error', e);
    return NextResponse.json(
      { unread: 0 },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
