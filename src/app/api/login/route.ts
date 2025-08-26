// src/app/api/login/route.ts
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { supabaseServer } from '@/lib/supabaseServer';
import { makeUserCode } from '@/lib/makeUserCode';

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
  try {
    const authz = req.headers.get('authorization') || '';
    const headerToken = authz.startsWith('Bearer ') ? authz.slice(7) : '';
    const body = await req.json().catch(() => ({}));
    const token = headerToken || body?.idToken;

    if (!token) {
      return NextResponse.json({ ok: false, error: 'NO_TOKEN' }, { status: 401 });
    }

    // デバッグ: admin 側の projectId / トークンの aud/iss をログ
    const decodedLoose = decodeJwtNoVerify(token);
    console.log('[login] admin projectId =', process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID);
    console.log('[login] token aud/iss =', decodedLoose?.payload?.aud, decodedLoose?.payload?.iss);

    // ここで検証（revoked チェックはまず切って切り分け）
    // うまく行ったら true に戻してOK
    const decoded = await adminAuth.verifyIdToken(token /*, true */);
    const firebase_uid = decoded.uid;
    const email = decoded.email || null;
    const emailVerified = !!decoded.email_verified;

    // 既存チェック
    const { data: existing, error: selErr } = await supabaseServer
      .from('users')
      .select('user_code')
      .eq('firebase_uid', firebase_uid)
      .limit(1);

    if (selErr) {
      return NextResponse.json({ ok: false, error: selErr.message }, { status: 500 });
    }

    if (!existing || existing.length === 0) {
      const user_code = await makeUserCode();
      const { error: insErr } = await supabaseServer
        .from('users')
        .insert([{ user_code, firebase_uid, click_email: email }]);

      if (insErr) {
        return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 });
      }
      return NextResponse.json({ ok: true, created: true, user_code, email_verified: emailVerified });
    }

    const user_code = existing[0].user_code as string;
    await supabaseServer.from('users').update({ click_email: email }).eq('firebase_uid', firebase_uid);

    return NextResponse.json({ ok: true, created: false, user_code, email_verified: emailVerified });
  } catch (e: any) {
    // verify 失敗原因を可視化
    console.error('[login] TOKEN_VERIFY_FAILED:', e?.errorInfo || e?.message || e);
    return NextResponse.json(
      { ok: false, error: 'TOKEN_VERIFY_FAILED', detail: e?.errorInfo || e?.message || String(e) },
      { status: 401 },
    );
  }
}
