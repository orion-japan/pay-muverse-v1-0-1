// src/app/api/my/invite-info/route.ts
export const runtime = 'nodejs';         // ★ Admin SDK を使うので必須
export const dynamic = 'force-dynamic';  // （任意）キャッシュ回避

import { NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';   // ← ハイフン版
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { buildInviteUrl, resolveOrigin } from '@/lib/invite';

export async function GET(req: Request) {
  try {
    // 1) Authorization ヘッダ取り出し
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    const idToken = authHeader.slice('Bearer '.length).trim();
    if (!idToken) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    // 2) Firebase IDトークンを検証
    const decoded = await adminAuth.verifyIdToken(idToken).catch(() => null);
    if (!decoded?.uid) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    // console.log('[invite-info] decoded uid:', decoded.uid);

    // 3) users から user_code 等を取得（firebase_uid は text 型）
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('user_code, rcode, mcode, leader_origin')
      .eq('firebase_uid', decoded.uid)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      // console.warn('[invite-info] user not found for uid:', decoded.uid);
      return NextResponse.json({ error: 'user not found' }, { status: 404 });
    }

    // 4) 招待URLを組み立てて返す
    const origin = resolveOrigin(req);
    const link = buildInviteUrl({
      origin,
      user_code: data.user_code,
      rcode: data.rcode || null,
      mcode: data.mcode || null,
      group: data.leader_origin || null,
    });

    return NextResponse.json({
      link,
      ref: data.user_code,
      rcode: data.rcode,
      mcode: data.mcode,
      group: data.leader_origin,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
