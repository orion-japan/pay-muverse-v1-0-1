// app/api/pay/account/register-card/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Payjp from 'payjp';
import https from 'node:https';
import { adminAuth } from '@/lib/firebase-admin';

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

function json(obj: any, status = 200) { return NextResponse.json(obj, { status }); }
function err(obj: any, status = 500) { return NextResponse.json({ success: false, ...obj }, { status }); }
const short = (s?: string, n = 8) => (s ? (s.length > n ? s.slice(0, n) + '…' : s) : '(none)');
const isCus = (v?: string | null) => !!v && /^cus_[a-z0-9]+/i.test(v);

export async function POST(req: Request) {
  const logTrail: string[] = [];
  try {
    const auth = req.headers.get('authorization') || '';
    let idToken: string | null = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const body = (await req.json().catch(() => ({}))) as any;
    if (!idToken && body?.idToken) idToken = body.idToken;

    // フロントの命名ゆれ対策
    const token: string | undefined = body?.token ?? body?.cardToken ?? body?.token_id ?? body?.cardTokenId;
    const userCodeFromBody: string | undefined = body?.user_code ?? body?.userCode;

    if (!token) return err({ error: 'card token がありません', logTrail }, 400);
    if (!idToken) return err({ error: 'missing_id_token', logTrail }, 401);

    const dec = await adminAuth.verifyIdToken(idToken, true).catch((e) => {
      throw new Error('invalid_id_token: ' + (e?.message || e));
    });
    const uid = dec?.uid as string;
    const email = (dec?.email as string | undefined) || (body?.email as string | undefined);
    logTrail.push(`✅ Firebase uid=${uid} email=${email || '-'}`);

    // ユーザー特定
    let user_code: string | null = null;
    let click_email: string | null = null;
    let customerId: string | null = null;

    if (userCodeFromBody) {
      const r = await sb.from('users')
        .select('user_code, click_email, payjp_customer_id, firebase_uid')
        .eq('user_code', userCodeFromBody).maybeSingle();
      if (r.data) {
        user_code = r.data.user_code;
        click_email = r.data.click_email ?? email ?? null;
        customerId = r.data.payjp_customer_id ?? null;
        if (!r.data.firebase_uid && uid) {
          await sb.from('users').update({ firebase_uid: uid }).eq('user_code', r.data.user_code);
        }
      }
    }
    if (!user_code) {
      const r = await sb.from('users')
        .select('user_code, click_email, payjp_customer_id')
        .eq('firebase_uid', uid).maybeSingle();
      if (r.data) {
        user_code = r.data.user_code;
        click_email = r.data.click_email ?? email ?? null;
        customerId = r.data.payjp_customer_id ?? null;
      }
    }
    if (!user_code && email) {
      const r = await sb.from('users')
        .select('user_code, click_email, payjp_customer_id')
        .eq('click_email', email).maybeSingle();
      if (r.data) {
        user_code = r.data.user_code;
        click_email = r.data.click_email ?? email ?? null;
        customerId = r.data.payjp_customer_id ?? null;
      }
    }
    if (!user_code) return err({ error: 'user_not_found', logTrail }, 404);

    // 既存 cus_ の検証（鍵違い/削除済みの 404 を踏んだら作り直す）
    if (customerId && !isCus(customerId)) {
      logTrail.push(`⚠ DB payjp_customer_id は cus_ ではありません: ${short(customerId, 12)} → 無効化`);
      customerId = null;
    }
    if (isCus(customerId)) {
      try {
        const c = await payjp.customers.retrieve(customerId!);
        logTrail.push(`🔁 reuse customer ${short(c.id, 12)}`);
        // メタデータはここで補完しておく（後方検索用）
        try {
          await payjp.customers.update(c.id, { metadata: { user_code } });
        } catch {}
      } catch (e: any) {
        const msg = e?.response?.body || e?.message || String(e);
        logTrail.push(`⚠ existing customer retrieve failed → 再作成へ: ${short(String(msg), 64)}`);
        customerId = null;
      }
    }

    // 顧客作成/更新
    if (!customerId) {
      const c = await payjp.customers.create({
        email: click_email || undefined,
        card: token,                              // ← 作成時にカードも登録（default_card になる）
        metadata: { user_code },
        description: `app user ${user_code}`,
      });
      customerId = c.id;
      logTrail.push(`🆕 customer created: ${short(customerId, 12)}`);
    } else {
      // 既存顧客にカード追加（default を更新）
      await payjp.customers.update(customerId, {
        card: token,
        email: click_email || undefined,          // 足りてなければ合わせて更新
        metadata: { user_code },                  // メタデータも補完
      });
      logTrail.push(`➕ card attached to ${short(customerId, 12)}`);
    }

    // デフォルトカード情報（brand/last4, ついでに default_card_id も保存）
    let card_brand: string | null = null;
    let card_last4: string | null = null;
    let default_card_id: string | null = null;
    try {
      const c = await payjp.customers.retrieve(customerId);
      const def = (c as any)?.default_card as string | undefined;
      if (def) {
        default_card_id = def;
        // ❗ 正式SDK: customers.cards.retrieve(customerId, def)
        const card = await (payjp as any).customers.cards.retrieve(customerId, def);
        card_brand = (card as any)?.brand || null;
        card_last4 = (card as any)?.last4 || null;
      }
    } catch (e: any) {
      logTrail.push(`ℹ default card fetch skipped: ${short(e?.message || String(e), 64)}`);
    }

    const { error: upErr } = await sb.from('users').update({
      payjp_customer_id: customerId,
      card_registered: true,
      ...(default_card_id ? { payjp_default_card_id: default_card_id } : {}),
      ...(card_brand ? { card_brand } : {}),
      ...(card_last4 ? { card_last4 } : {}),
    }).eq('user_code', user_code);
    if (upErr) return err({ error: 'db_update_failed', detail: upErr.message, logTrail }, 500);

    return json({
      success: true,
      customer_id: customerId,
      user_code,
      default_card_id: default_card_id,
      card_brand,
      card_last4,
      logTrail,
    }, 200);
  } catch (e: any) {
    const msg = e?.message || String(e);
    const isCardErr = /card|invalid|security code|insufficient|cvc|3d|three[-\s]?d/i.test(msg);
    return err({ error: isCardErr ? 'payment_error' : 'internal_error', detail: msg, logTrail }, isCardErr ? 402 : 500);
  }
}

export async function GET() {
  return err({ error: 'Method Not Allowed (POST only)' }, 405);
}
