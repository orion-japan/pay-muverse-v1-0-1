// middleware.ts
import { NextResponse, type NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ✅ 例外処理: 課金APIなどはミドルウェアを素通りさせる
  if (pathname.startsWith('/api/credits/')) {
    return NextResponse.next();
  }

  // 💡 既存の Cookie 発行処理（保持）
  const res = NextResponse.next();

  if (!req.cookies.get('mu_sid')?.value) {
    res.cookies.set({
      name: 'mu_sid',
      value: crypto.randomUUID(),
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365, // 1年
    });
  }

  return res;
}

// matcher設定はそのままでOK
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
