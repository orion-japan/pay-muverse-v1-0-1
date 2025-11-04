// app/api/pay/subscribe/cancel/route.ts  ← 置換
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Payjp from 'payjp';
import { adminAuth } from '@/lib/firebase-admin';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);
const payjp = Payjp(process.env.PAYJP_SECRET_KEY!);

export async function POST(req: NextRequest) {
  const logTrail: string[] = [];
  try {
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token)
      return NextResponse.json(
        { success: false, error: 'missing_id_token', logTrail },
        { status: 401 },
      );

    let decoded: any;
    try {
      decoded = await adminAuth.verifyIdToken(token, true);
    } catch (e: any) {
      return NextResponse.json(
        { success: false, error: 'invalid_id_token', detail: e?.message },
        { status: 401 },
      );
    }
    const firebase_uid: string = decoded.uid;

    const body = (await req.json().catch(() => ({}))) as any;
    const user_code_from_q = body?.user_code as string | undefined;

    // ユーザー解決
    let user_code: string | null = null;
    let customer_id: string | null = null;
    let subscription_id: string | null = null;

    if (user_code_from_q) {
      const { data } = await sb
        .from('users')
        .select('user_code, payjp_customer_id, payjp_subscription_id, firebase_uid')
        .eq('user_code', user_code_from_q)
        .maybeSingle();
      if (!data)
        return NextResponse.json({ success: false, error: 'user_not_found' }, { status: 404 });
      if (data.firebase_uid && data.firebase_uid !== firebase_uid) {
        return NextResponse.json({ success: false, error: 'forbidden_mismatch' }, { status: 403 });
      }
      user_code = data.user_code;
      customer_id = data.payjp_customer_id;
      subscription_id = data.payjp_subscription_id;
    } else {
      const { data } = await sb
        .from('users')
        .select('user_code, payjp_customer_id, payjp_subscription_id')
        .eq('firebase_uid', firebase_uid)
        .maybeSingle();
      if (!data)
        return NextResponse.json({ success: false, error: 'user_not_found' }, { status: 404 });
      user_code = data.user_code;
      customer_id = data.payjp_customer_id;
      subscription_id = data.payjp_subscription_id;
    }
    if (!customer_id)
      return NextResponse.json({ success: false, error: 'no_customer_id' }, { status: 400 });

    // アクティブなサブスクを全部キャンセル
    try {
      const listed = await payjp.subscriptions.list({ customer: customer_id, limit: 100 } as any);
      const targets = (listed?.data ?? []).filter((s: any) =>
        ['active', 'trial', 'trialing', 'paused'].includes(String(s?.status)),
      );
      for (const s of targets) {
        try {
          await payjp.subscriptions.cancel(s.id, { at_period_end: false } as any);
        } catch (e) {
          logTrail.push(`cancel failed ${s.id}`);
        }
      }
    } catch (e) {
      logTrail.push('list/cancel error');
    }

    // DB を即時 free に
    await sb
      .from('users')
      .update({
        payjp_subscription_id: null,
        plan_status: 'free',
        click_type: 'free',
        next_payment_date: null,
      })
      .eq('user_code', user_code!);

    // 任意：履歴に追記（存在すれば）
    try {
      await sb.from('plan_history').insert({
        user_code,
        from_plan_status: 'unknown',
        to_plan_status: 'free',
        from_click_type: 'unknown',
        to_click_type: 'free',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        reason: 'subscription.canceled(manual)',
        source: 'api',
      });
    } catch {}

    return NextResponse.json({ success: true, logTrail });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'error' }, { status: 500 });
  }
}
