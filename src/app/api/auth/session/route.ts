// src/app/api/auth/session/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';

const COOKIE_NAME = '__session';
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;

export async function POST(req: Request) {
  try {
    const { idToken } = await req.json();
    if (!idToken) return NextResponse.json({ error: 'missing idToken' }, { status: 400 });

    // IDトークンの有効性チェック
    const decoded = await adminAuth.verifyIdToken(idToken, true);

    // Firebase の「セッションCookie」を作成
    const sessionCookie = await adminAuth.createSessionCookie(idToken, {
      expiresIn: ONE_WEEK,
    });

    const res = NextResponse.json({ ok: true, uid: decoded.uid });
    // HttpOnly Cookie をセット（ローカルは secure=false でOK）
    res.cookies.set({
      name: COOKIE_NAME,
      value: sessionCookie,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: ONE_WEEK / 1000,
    });
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'auth failed' }, { status: 401 });
  }
}
