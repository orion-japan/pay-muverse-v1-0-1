// app/api/account/refresh/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Payjp from 'payjp';
import { adminAuth } from '@/lib/firebase-admin';

/* =========================
   ENV
========================= */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PAYJP_SECRET_KEY = process.env.PAYJP_SECRET_KEY || '';

if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error('Env missing: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE');
}
if (!PAYJP_SECRET_KEY) {
  throw new Error('Env missing: PAYJP_SECRET_KEY');
}

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const payjp = new Payjp(PAYJP_SECRET_KEY);

/* =========================
   返却ヘルパ
========================= */
function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

/* =========================
   プランID → アプリ内ラベル
   ※ あなたの PAY.JP プランIDに合わせて埋めてください
========================= */
const PLAN_MAP: Record<
  string,
  { plan_status: 'free' | 'pro' | 'master'; click_type: 'free' | 'pro' | 'master' | 'admin' }
> = {
  // 例:
  // 'plan_pro_monthly': { plan_status: 'pro',    click_type: 'pro' },
  // 'plan_master_vip':  { plan_status: 'master', click_type: 'master' },
};

/* =========================
   ユーザー解決
========================= */
async function getUserByUid(firebase_uid: string) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select(
      [
        'user_code',
        'click_type',
        'plan_status',
        'plan_expires_at',
        'next_payment_date', // 互換
        'payjp_customer_id',
        'payjp_subscription_id',
      ].join(', '),
    )
    .eq('firebase_uid', firebase_uid)
    .maybeSingle();

  if (error || !data) return { error: 'USER_NOT_FOUND' as const, data: null as any };
  return { error: null as any, data };
}

/* =========================
   PAY.JP からサブスク取得
   - subscription_id があれば直接取得
   - なければ customer から直近activeを推定
========================= */
async function fetchActiveSubscription(params: {
  subscriptionId?: string | null;
  customerId?: string | null;
}) {
  const { subscriptionId, customerId } = params;

  // 1) 直接ID
  if (subscriptionId) {
    try {
      const sub: any = await payjp.subscriptions.retrieve(subscriptionId);
      if (sub && sub.status === 'active') return sub;
    } catch {
      /* noop */
    }
  }

  // 2) customer から候補探索（必要に応じて調整）
  if (customerId) {
    try {
      // PAY.JP SDK の list はオプションで customer を絞り込める
      // @ts-ignore 型定義が古い場合があるためignore
      const list: any = await payjp.subscriptions.list({ customer: customerId, limit: 10 });
      const items: any[] = Array.isArray(list?.data) ? list.data : [];
      // active 最優先、なければ最新1件
      const active = items.find((s) => s.status === 'active');
      return active || items[0] || null;
    } catch {
      /* noop */
    }
  }

  return null;
}

/* =========================
   メイン
========================= */
export async function POST(req: NextRequest) {
  try {
    // idToken は Authorization: Bearer または body.idToken
    const authHeader = req.headers.get('authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    let bodyToken: string | null = null;
    try {
      const b = await req.json().catch(() => ({}));
      bodyToken = typeof b?.idToken === 'string' ? b.idToken : null;
    } catch {
      /* bodyなし */
    }

    const idToken = bearer || bodyToken;
    if (!idToken) return json(401, { ok: false, error: 'NO_TOKEN' });

    // Firebase 検証
    let decoded: any;
    try {
      decoded = await adminAuth.verifyIdToken(idToken, true);
    } catch {
      return json(403, { ok: false, error: 'INVALID_TOKEN' });
    }

    // DBのユーザーを取得
    const { data: u, error: uerr } = await getUserByUid(decoded.uid);
    if (uerr || !u) return json(404, { ok: false, error: 'USER_NOT_FOUND' });

    // 管理者/マスターの権限は課金と独立運用の場合があるため、必要なら保護
    const isPrivileged = u.click_type === 'admin' || u.click_type === 'master';

    // PAY.JP 参照
    const sub: any = await fetchActiveSubscription({
      subscriptionId: u.payjp_subscription_id,
      customerId: u.payjp_customer_id,
    });

    // 既定値
    let nextPlan: 'free' | 'pro' | 'master' = 'free';
    let nextClick: 'free' | 'pro' | 'master' | 'admin' = 'free';
    let validUntil: Date | null = null;
    let eventLabel = 'synced';

    if (sub && sub.status === 'active') {
      const planId: string = (sub.plan && (sub.plan as any).id) || '';
      const mapping = PLAN_MAP[planId];

      if (mapping) {
        nextPlan = mapping.plan_status;
        nextClick = mapping.click_type;
      } else {
        // 未登録のプランIDは pro に寄せるなどの安全側既定
        nextPlan = 'pro';
        nextClick = 'pro';
      }

      const endEpoch = (sub as any)?.current_period_end;
      if (endEpoch) validUntil = new Date(endEpoch * 1000);

      eventLabel = 'synced';
    } else {
      // アクティブでない → free にリセット
      nextPlan = 'free';
      nextClick = 'free';
      eventLabel = 'canceled'; // 状態的に有効ではないため
    }

    // 特権ロール保護（必要ない場合は削除可）
    if (isPrivileged) {
      nextClick = u.click_type as any;
      // master/admin の plan_status は運用に合わせて（ここでは現状維持）
      nextPlan = (u.plan_status as any) || nextPlan;
    }

    // 差分判定（互換: plan_expires_at / next_payment_date のどちらかが変われば更新）
    const currentValid = u.plan_expires_at || u.next_payment_date || null;
    const changed =
      u.click_type !== nextClick ||
      u.plan_status !== nextPlan ||
      String(currentValid || '') !== String(validUntil || '');

    if (changed) {
      // users 更新（互換のため plan_expires_at と next_payment_date を両方更新）
      const { error: upErr } = await supabaseAdmin
        .from('users')
        .update({
          click_type: nextClick,
          plan_status: nextPlan,
          plan_expires_at: validUntil,
          next_payment_date: validUntil, // 互換
        })
        .eq('user_code', u.user_code);

      if (upErr) return json(500, { ok: false, error: 'UPDATE_FAILED', detail: upErr.message });

      // 履歴追記
      await supabaseAdmin.rpc('append_plan_history', {
        p_user_code: u.user_code,
        p_event: eventLabel,
        p_plan_status: nextPlan,
        p_click_type: nextClick,
        p_valid_until: validUntil,
        p_source: 'sync',
        p_note: { from: 'refresh', subscription_id: u.payjp_subscription_id || null },
      });
    }

    return json(200, {
      ok: true,
      changed,
      now: {
        user_code: u.user_code,
        click_type: nextClick,
        plan_status: nextPlan,
        valid_until: validUntil,
      },
    });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || 'INTERNAL' });
  }
}
