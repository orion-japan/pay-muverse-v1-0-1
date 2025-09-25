import { NextResponse } from 'next/server';
import { getUserInfo } from '@/lib/server/userinfo';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const user_code = searchParams.get('user_code') ?? undefined;
    const ui = await getUserInfo({ user_code });
    return NextResponse.json(ui);
  } catch (e: any) {
    const message = e?.message ?? 'unknown';
    const status =
      message === 'USER_NOT_FOUND' ? 404 :
      message === 'user_code or idToken required' ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
