// middleware.ts
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

// この配列に入っている API は認証チェックをスキップ
const PUBLIC_API_PREFIXES = [
  '/api/push/vapid-public-key',
  '/api/push/save-subscription',
  '/api/push/send',
  '/api/notification-settings',
  '/api/notification-settings/save',
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 許可リストに入っているパスは素通し
  if (PUBLIC_API_PREFIXES.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // ↓ ここに既存の認証チェックがあれば残す
  // 例えばセッションCookieの確認など
  // if (!req.cookies.get('session')) {
  //   return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // }

  return NextResponse.next();
}

// matcher: APIルートを対象にする
export const config = {
  matcher: ['/api/:path*'],
};
