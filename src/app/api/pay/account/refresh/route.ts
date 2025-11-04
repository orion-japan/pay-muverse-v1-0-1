// src/app/api/pay/account/refresh/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { adminAuth } from '@/lib/firebase-admin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/* =========================
   Supabase 初期化
========================= */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error('Env missing: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

/* =========================
   型定義
========================= */
type UserRow = {
  user_code: string;
  click_type: string | null;
  plan_status: string | null;
  next_payment_date?: string | null;
  last_payment_date?: string | null;
};

/* =========================
   plan_status ←→ click_type を同期
========================= */
async function syncPlanStatusIfNeeded(user: UserRow) {
  if (user.plan_status === user.click_type) {
    return { ok: true }; // すでに一致
  }

  const { error } = await supabase
    .from('users')
    .update({ plan_status: user.click_type })
    .eq('user_code', user.user_code);

  if (error) return { ok: false, error };
  return { ok: true };
}

/* =========================
   メイン POST
========================= */
export async function POST(req: NextRequest) {
  try {
    // Authorization: Bearer <idToken>
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return NextResponse.json({ error: 'No token' }, { status: 401 });
    }

    // Firebase トークン検証
    let decoded: any;
    try {
      decoded = await adminAuth.verifyIdToken(token, true);
    } catch {
      return NextResponse.json({ error: 'Invalid token' }, { status: 403 });
    }
    const firebase_uid: string = decoded.uid;

    // DBからユーザー取得
    const { data, error } = await supabase
      .from('users')
      .select('user_code, click_type, plan_status, next_payment_date, last_payment_date')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle();

    if (error || !data) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const user = data as UserRow;

    // plan_status を click_type に同期
    const sync = await syncPlanStatusIfNeeded(user);
    if (!sync.ok) {
      return NextResponse.json(
        { error: 'sync failed', detail: sync.error?.message || null },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      user_code: user.user_code,
      click_type: user.click_type,
      plan_status: user.click_type, // 同期後の値
      next_payment_date: user.next_payment_date,
      last_payment_date: user.last_payment_date,
    });
  } catch (err: any) {
    return NextResponse.json({ error: 'Server error', detail: String(err) }, { status: 500 });
  }
}
