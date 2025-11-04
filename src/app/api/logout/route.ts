// src/app/api/logout/route.ts
import { NextResponse } from 'next/server';

export async function POST() {
  // セッションCookieやキャッシュを削除
  return NextResponse.json({ success: true });
}
