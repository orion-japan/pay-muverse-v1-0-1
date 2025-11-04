import { NextResponse, type NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const res = NextResponse.next();

  if (!req.cookies.get('mu_sid')?.value) {
    res.cookies.set({
      name: 'mu_sid',
      value: crypto.randomUUID(),
      httpOnly: true,
      sameSite: 'lax', // ← 小文字
      path: '/',
      maxAge: 60 * 60 * 24 * 365, // 1年（秒）
    });
  }

  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
