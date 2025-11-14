// src/app/api/login/route.ts
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
// 実体は supabaseAdmin（service_role）。呼び名は既存どおり維持
import { supabaseAdmin as supabaseServer } from '@/lib/supabaseAdmin';
import { makeUserCode } from '@/lib/makeUserCode';

const DEBUG = process.env.DEBUG_LOCAL === '1';
const L = (...args: any[]) => {
  if (DEBUG) console.log('[api/login]', ...args);
};

function decodeJwtNoVerify(idToken: string) {
  try {
    const [h, p] = idToken.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
    const payload = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    return { header, payload };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  L('route loaded. DEBUG_LOCAL=1');
  L('request start');

  try {
    const authz = req.headers.get('authorization') || '';
    const headerToken = authz.startsWith('Bearer ') ? authz.slice(7) : '';
    const body = await req.json().catch(() => ({}));
    const token = headerToken || body?.idToken;

    if (!token) {
      L('NO_TOKEN');
      return NextResponse.json({ ok: false, error: 'NO_TOKEN' }, { status: 401 });
    }

    // 軽いデコード（監視用。prodでは出ない）
    const loose = decodeJwtNoVerify(token);
    L('admin projectId =', process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID);
    L('token aud/iss =', loose?.payload?.aud, loose?.payload?.iss);

    // ★ revoked チェックは一旦OFFで切り分け（問題なければ true に戻す）
    const decoded = await adminAuth.verifyIdToken(token /*, true */);
    const firebase_uid = decoded.uid;
    const email = decoded.email || null;
    const emailVerified = !!decoded.email_verified;
    L('decoded uid/email/verified =', firebase_uid, email, emailVerified);

    // 既存チェック（service_role 経由。RLSバイパス）
    const selT0 = Date.now();
    const { data: existing, error: selErr } = await supabaseServer
      .from('users')
      .select('user_code')
      .eq('firebase_uid', firebase_uid)
      .limit(1);
    L('select existing ms=', Date.now() - selT0, 'err=', selErr?.message, 'rows=', existing?.length);

    if (selErr) {
      L('DB_SELECT_ERROR', selErr);
      return NextResponse.json({ ok: false, error: 'DB_SELECT_ERROR', detail: selErr.message }, { status: 500 });
    }

    // 既存なし → upsert（firebase_uid で競合時は更新）、user_code 衝突は最大3回リトライ
    if (!existing || existing.length === 0) {
      let user_code = '';
      let lastErr: any = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        user_code = await makeUserCode();
        L(`attempt#${attempt} makeUserCode=${user_code}`);

        const insT0 = Date.now();
        const { data: up, error: insErr } = await supabaseServer
          .from('users')
          .upsert(
            { user_code, firebase_uid, click_email: email },
            { onConflict: 'firebase_uid', ignoreDuplicates: false },
          )
          .select('user_code')
          .single();

        L('upsert ms=', Date.now() - insT0, 'err=', insErr?.message, 'data=', up);

        if (!insErr && up?.user_code) {
          // 正常
          L('created user_code=', up.user_code);
          return NextResponse.json({
            ok: true,
            created: true,
            user_code: up.user_code,
            email_verified: emailVerified,
          });
        }

        // 衝突（23505）等はリトライ、それ以外は即エラー
        lastErr = insErr;
        const code = (insErr as any)?.code || (insErr as any)?.details || (insErr as any)?.hint || '';
        if (typeof code === 'string' && code.includes('23505')) {
          L('unique_violation → retry');
          continue;
        } else {
          break;
        }
      }

      // ここまで来たら失敗
      L('DB_INSERT_ERROR', lastErr);
      return NextResponse.json(
        { ok: false, error: 'DB_INSERT_ERROR', detail: lastErr?.message || String(lastErr) },
        { status: 500 },
      );
    }

    // 既存あり → email 同期だけして返す
    const user_code = existing[0].user_code as string;
    const updT0 = Date.now();
    const { error: updErr } = await supabaseServer
      .from('users')
      .update({ click_email: email })
      .eq('firebase_uid', firebase_uid);
    L('update email ms=', Date.now() - updT0, 'err=', updErr?.message);

    if (updErr) {
      // 更新失敗でもログだけ残して継続（致命ではない）
      L('WARN: UPDATE_EMAIL_FAILED', updErr);
    }

    L('request end ok ms=', Date.now() - t0);
    return NextResponse.json({
      ok: true,
      created: false,
      user_code,
      email_verified: emailVerified,
    });
  } catch (e: any) {
    // verify 失敗原因を可視化
    L('TOKEN_VERIFY_FAILED', e?.errorInfo || e?.message || e);
    return NextResponse.json(
      { ok: false, error: 'TOKEN_VERIFY_FAILED', detail: e?.errorInfo || e?.message || String(e) },
      { status: 401 },
    );
  }
}
