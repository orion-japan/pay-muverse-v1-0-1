// src/app/api/get-user-code/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const cookie = req.cookies.get('user_code');
  if (!cookie) {
    return NextResponse.json({ error: 'ユーザーコードが存在しません' }, { status: 404 });
  }

  return NextResponse.json({ user_code: cookie.value });
}
