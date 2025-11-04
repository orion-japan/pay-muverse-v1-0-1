// src/app/api/user-info/route.ts
import { NextResponse } from 'next/server';
import { getUserInfo } from '@/lib/server/userinfo';

function withCORS(json: any, status = 200) {
  return NextResponse.json(json, {
    status,
    headers: {
      'Access-Control-Allow-Origin': process.env.MU_ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export async function OPTIONS() {
  return withCORS({}, 200);
}

export async function POST(req: Request) {
  const traceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const body = await req.json().catch(() => ({}) as any);
    const { user_code, idToken } = body ?? {};
    const ui = await getUserInfo({ user_code, idToken });
    return withCORS({ traceId, ok: true, ...ui }, 200);
  } catch (e: any) {
    const msg = e?.message ?? 'unknown';
    const status =
      msg === 'USER_NOT_FOUND' ? 404 : msg === 'user_code or idToken required' ? 400 : 500;
    return withCORS({ traceId, error: msg }, status);
  }
}
