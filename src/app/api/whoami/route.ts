// src/app/api/whoami/route.ts
export const runtime = 'nodejs'; // ★これを一番上に追加


import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';

function json(data: any, status = 200) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// verifyFirebaseAndAuthorize の戻りが userCode / user_code どちらでも対応
type Authish = Partial<{
  userCode: string;
  user_code: string;
  uid: string;
  email: string;
}>;

export async function GET(req: NextRequest) {
  try {
    const auth = (await verifyFirebaseAndAuthorize(req)) as Authish;

    const code = (auth && (auth.userCode ?? auth.user_code)) ?? null;

    if (!code) return json({ ok: false, error: 'unauthorized' }, 401);

    // 互換のため両方返す（フロントは userCode を使えばOK）
    return json({
      ok: true,
      userCode: code,
      user_code: code,
      uid: auth?.uid ?? null,
      email: auth?.email ?? null,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'internal_error' }, 500);
  }
}
