// app/api/pay/cancel-subscription/route.ts
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Payjp from 'payjp';
import { adminAuth } from '@/lib/firebase-admin';

function mustEnv(n: string) { const v = process.env[n]; if (!v) throw new Error(`Missing env: ${n}`); return v; }
const sb = createClient(mustEnv('NEXT_PUBLIC_SUPABASE_URL'), mustEnv('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const payjp = Payjp(mustEnv('PAYJP_SECRET_KEY'));

export async function POST(req: NextRequest) {
  const logTrail: string[] = [];
  try {
    const auth = req.headers.get('authorization') || '';
    const idToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!idToken) return NextResponse.json({ success:false, error:'missing_id_token' }, { status:401 });

    const dec = await adminAuth.verifyIdToken(idToken, true).catch((e) => { throw new Error('invalid_id_token:' + (e?.message || e)); });
    const uid = dec?.uid as string;

    const { data: user, error } = await sb.from('users')
      .select('user_code, payjp_subscription_id, payjp_customer_id')
      .eq('firebase_uid', uid).maybeSingle();
    if (error || !user) return NextResponse.json({ success:false, error:'user_not_found', logTrail }, { status:404 });

    // まず subscription_id があればそれを解約、無ければ customer からアクティブを検索
    let cancelled = 0;
    if (user.payjp_subscription_id) {
      try {
        await payjp.subscriptions.cancel(user.payjp_subscription_id, { at_period_end:false } as any);
        cancelled++;
      } catch (e:any) { logTrail.push('cancel by id failed: ' + (e?.message||e)); }
    }
    if (!cancelled && user.payjp_customer_id) {
      const list = await payjp.subscriptions.list({ customer: user.payjp_customer_id, limit: 100 } as any);
      for (const s of list.data) {
        if (['active','trial','trialing','paused'].includes(String(s.status))) {
          try { await payjp.subscriptions.cancel(s.id, { at_period_end:false } as any); cancelled++; }
          catch (e:any) { logTrail.push('cancel list item failed: ' + (e?.message||e)); }
        }
      }
    }

    // DB 整理
    await sb.from('users').update({
      payjp_subscription_id: null,
      next_payment_date: null,
      last_payment_date: null,
      plan_status: 'free',
      click_type: 'free',
    }).eq('user_code', user.user_code);

    return NextResponse.json({ success:true, cancelled, logTrail });
  } catch (e:any) {
    return NextResponse.json({ success:false, error:e?.message||String(e) }, { status:500 });
  }
}
