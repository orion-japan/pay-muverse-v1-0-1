// app/api/talk/unread-count/route.ts
export const runtime = 'nodejs';          // ← これが最重要（Edgeだとハングの元）
export const dynamic = 'force-dynamic';   // キャッシュ抑止の保険

import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { createClient } from '@supabase/supabase-js';

/* ====== env 安全化 ====== */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || '';
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('[unread-count] Missing env SUPABASE_URL / SERVICE_ROLE');
}

// Admin用途の Supabase（セッション保持なし）
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// uid -> user_code 解決（v2 API 安全化）
async function uidToUserCode(uid: string) {
  // firebase_uid 優先
  const a = await supabase
    .from('users')
    .select('user_code')
    .eq('firebase_uid', uid)
    .maybeSingle();

  if (a?.data?.user_code) return String(a.data.user_code);

  // 旧 uid フィールド fallback
  const b = await supabase
    .from('users')
    .select('user_code')
    .eq('uid', uid)
    .maybeSingle();

  return (b?.data?.user_code ? String(b.data.user_code) : null);
}

// CORS（必要なら）
export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function GET(req: NextRequest) {
  try {
    // Authorization: Bearer <idToken>
    const authz = req.headers.get('authorization') || '';
    const token = authz.toLowerCase().startsWith('bearer ')
      ? authz.slice(7).trim()
      : '';

    if (!token) {
      return NextResponse.json(
        { unread: 0 },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // firebase-admin で検証（Edgeだとここが止まりがち → nodejs強制で回避）
    const decoded = await adminAuth.verifyIdToken(token).catch(() => null);
    if (!decoded?.uid) {
      return NextResponse.json(
        { unread: 0 },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const me = await uidToUserCode(decoded.uid);
    if (!me) {
      return NextResponse.json(
        { unread: 0 },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // RPC 呼び出し（引数名は明示）
    const { data, error } = await supabase.rpc('unread_total_sum_v3', { me: me });
    if (error) {
      console.warn('[unread-count] rpc error', error);
      return NextResponse.json(
        { unread: 0 },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const unread = Number(data ?? 0);
    return NextResponse.json(
      { unread: Number.isFinite(unread) ? unread : 0 },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    console.error('[unread-count] GET error', e);
    return NextResponse.json(
      { unread: 0 },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
