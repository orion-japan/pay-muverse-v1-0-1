// src/app/api/pay/account/register-card/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Payjp from 'payjp';
import https from 'node:https';
import { adminAuth } from '@/lib/firebase-admin';

/** ========= Env / Client ========= */
function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
const SB_URL = mustEnv('NEXT_PUBLIC_SUPABASE_URL');
const SB_SERVICE_KEY = mustEnv('SUPABASE_SERVICE_ROLE_KEY');
const sb = createClient(SB_URL, SB_SERVICE_KEY, { auth: { persistSession: false } });

const agent = new https.Agent({ keepAlive: true });
const payjp = Payjp(mustEnv('PAYJP_SECRET_KEY'), {
  timeout: 120_000,
  maxRetries: 2,
  httpAgent: agent,
});

/** ========= Helpers ========= */
function jsonOk(obj: any, status = 200) {
  return NextResponse.json(obj, { status });
}
function jsonErr(obj: any, status = 500) {
  return NextResponse.json({ success: false, ...obj }, { status });
}
function short(str: string | null | undefined, left = 8) {
  if (!str) return '(none)';
  return str.length > left ? `${str.slice(0, left)}…` : str;
}

/** ========= POST: register card ========= */
export async function POST(req: Request) {
  const t0 = Date.now();
  const logTrail: string[] = [];
  logTrail.push('📩 [/account/register-card] HIT');

  try {
    // 1) 入力
    const authHeader = req.headers.get('authorization') || '';
    let idToken: string | null = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    const body = (await req.json().catch(() => ({}))) as any;
    if (!idToken && body?.idToken) idToken = body.idToken; // 保険

    // フロントのキー揺れ吸収
    const token: string | undefined = body?.token ?? body?.cardToken;
    const userCodeFromBody: string | undefined = body?.user_code ?? body?.userCode;

    logTrail.push(
      `🟢 受信: user_code=${userCodeFromBody ?? '(auto)'}, token=${short(token)}, hasIdToken=${!!idToken}`
    );

    if (!token) return jsonErr({ error: 'card token がありません', logTrail }, 400);
    if (!idToken) return jsonErr({ error: 'missing_id_token', logTrail }, 401);

    // 2) Firebase 検証
    let firebase_uid: string | null = null;
    let emailFromToken: string | null = null;
    try {
      const decoded: any = await adminAuth.verifyIdToken(idToken, true);
      firebase_uid = decoded?.uid ?? null;
      emailFromToken = decoded?.email ?? null;
      logTrail.push(`✅ Firebase verified: uid=${firebase_uid}, email=${emailFromToken}`);
    } catch (e: any) {
      logTrail.push(`❌ invalid_id_token: ${e?.message || e}`);
      return jsonErr({ error: 'invalid_id_token', detail: String(e?.message || e), logTrail }, 401);
    }

    // 3) ユーザー特定（優先順：body.user_code → firebase_uid → click_email）
    let user_code: string | null = null;
    let click_email: string | null = null;
    let payjp_customer_id: string | null = null;

    // 3-0) user_code 明示
    if (userCodeFromBody) {
      const { data, error } = await sb
        .from('users')
        .select('user_code, click_email, payjp_customer_id, firebase_uid')
        .eq('user_code', userCodeFromBody)
        .maybeSingle();

      if (error) logTrail.push(`⚠ user_code lookup error: ${error.message}`);
      if (data) {
        user_code = data.user_code;
        click_email = data.click_email ?? emailFromToken ?? null;
        payjp_customer_id = data.payjp_customer_id;

        // 認可チェック：既に firebase_uid/click_email があり不一致なら拒否
        const uidOk = data.firebase_uid ? data.firebase_uid === firebase_uid : true;
        const mailOk = data.click_email ? data.click_email === emailFromToken : true;
        if (!uidOk || !mailOk) {
          logTrail.push('⛔ forbidden_mismatch: uid/email mismatch');
          return jsonErr({ error: 'forbidden_mismatch', logTrail }, 403);
        }

        // 不足あれば同期
        const updates: Record<string, any> = {};
        if (!data.firebase_uid && firebase_uid) updates.firebase_uid = firebase_uid;
        if (!data.click_email && emailFromToken) {
          updates.click_email = emailFromToken;
          click_email = emailFromToken;
        }
        if (Object.keys(updates).length) {
          await sb.from('users').update(updates).eq('user_code', data.user_code);
          logTrail.push('↺ user row synced (firebase_uid / click_email)');
        }
      }
    }

    // 3-1) uid
    if (!user_code && firebase_uid) {
      const { data, error } = await sb
        .from('users')
        .select('user_code, click_email, payjp_customer_id')
        .eq('firebase_uid', firebase_uid)
        .maybeSingle();

      if (error) logTrail.push(`⚠ uid lookup error: ${error.message}`);
      if (data) {
        user_code = data.user_code;
        click_email = data.click_email ?? emailFromToken ?? null;
        payjp_customer_id = data.payjp_customer_id;

        if (!data.click_email && emailFromToken) {
          await sb.from('users').update({ click_email: emailFromToken }).eq('user_code', data.user_code);
          logTrail.push('↺ user row synced (click_email)');
        }
      }
    }

    // 3-2) email
    if (!user_code && emailFromToken) {
      const { data, error } = await sb
        .from('users')
        .select('user_code, click_email, payjp_customer_id, firebase_uid')
        .eq('click_email', emailFromToken)
        .maybeSingle();

      if (error) logTrail.push(`⚠ email lookup error: ${error.message}`);
      if (data) {
        user_code = data.user_code;
        click_email = data.click_email ?? emailFromToken;
        payjp_customer_id = data.payjp_customer_id;

        if (firebase_uid && data.firebase_uid !== firebase_uid) {
          await sb.from('users').update({ firebase_uid }).eq('user_code', data.user_code);
          logTrail.push('↺ user row synced (firebase_uid)');
        }
      }
    }

    if (!user_code || !click_email) {
      logTrail.push(`❌ user_not_found (user_code=${user_code}, email=${click_email})`);
      return jsonErr({ error: 'user_not_found', logTrail }, 404);
    }

    // 4) PAY.JP: 顧客作成 or カード差し替え
    let customerId = payjp_customer_id;

    if (!customerId) {
      logTrail.push('🛠 creating new PAY.JP customer with card…');
      const t = Date.now();
      const customer = await payjp.customers.create({
        email: click_email,
        card: token, // 同時登録
        metadata: { user_code },
      });
      customerId = customer.id;
      logTrail.push(`✅ PAY.JP customer.create ok (${Date.now() - t}ms): ${customerId}`);

      // 5-a) Supabase 反映（存在する列だけ）
      const { data: after, error: upErr } = await sb
        .from('users')
        .update({
          payjp_customer_id: customerId,
          card_registered: true,
        })
        .eq('user_code', user_code)
        .select('user_code, payjp_customer_id, card_registered')
        .single();

      if (upErr || !after) {
        logTrail.push(`❌ Supabase update failed (create): ${upErr?.message || 'no row'}`);
        // 失敗時は 500 で返す
        return jsonErr({ error: 'db_update_failed', detail: upErr?.message || 'no row', logTrail }, 500);
      }

      logTrail.push(`📦 DB after(create): ${JSON.stringify(after)}`);
      logTrail.push(`⏳ total: ${Date.now() - t0}ms`);
      return jsonOk({ success: true, customer_id: customerId, user_code, logTrail }, 200);
    } else {
      logTrail.push(`🛠 updating existing PAY.JP customer (${customerId}) card…`);
      const t = Date.now();
      await payjp.customers.update(customerId, { card: token });
      logTrail.push(`✅ PAY.JP customers.update ok (${Date.now() - t}ms)`);

      // 5-b) Supabase 反映（存在する列だけ）
      const { data: after2, error: upErr2 } = await sb
        .from('users')
        .update({
          // 念のため customer_id も揃えておく（空だったケースの補完）
          payjp_customer_id: customerId,
          card_registered: true,
        })
        .eq('user_code', user_code)
        .select('user_code, payjp_customer_id, card_registered')
        .single();

      if (upErr2 || !after2) {
        logTrail.push(`❌ Supabase update failed (update): ${upErr2?.message || 'no row'}`);
        return jsonErr({ error: 'db_update_failed', detail: upErr2?.message || 'no row', logTrail }, 500);
      }

      logTrail.push(`📦 DB after(update): ${JSON.stringify(after2)}`);
      logTrail.push(`⏳ total: ${Date.now() - t0}ms`);
      return jsonOk({ success: true, customer_id: customerId, user_code, logTrail }, 200);
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    logTrail.push(`🔥 unhandled: ${msg}`);
    // PAY.JP のカード系エラーは 402 に寄せる
    const isCardErr = /card|invalid|security code|insufficient|cvc/i.test(msg);
    return jsonErr({ error: isCardErr ? 'payment_error' : 'internal_error', detail: msg, logTrail }, isCardErr ? 402 : 500);
  }
}

/** 明示的に GET は 405 を返す（誤アクセス検知用にログ） */
export async function GET() {
  return jsonErr({ error: 'Method Not Allowed (POST only)' }, 405);
}
