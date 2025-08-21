// src/app/api/push/vapid-public-key/route.ts
import { NextResponse } from 'next/server';

export async function GET() {
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!key) {
    return NextResponse.json({ error: 'VAPID public key not configured' }, { status: 500 });
  }
  // 文字列そのまま返す or JSON どちらでも。subscribe側に合わせる
  return new NextResponse(key, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
