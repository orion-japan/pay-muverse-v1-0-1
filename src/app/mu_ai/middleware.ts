import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const response = NextResponse.next()

  const userCode =
    request.cookies.get('user_code')?.value ||
    request.nextUrl.searchParams.get('user')

  if (userCode) {
    response.cookies.set({
      name: 'user_code',
      value: userCode,
      path: '/',
      httpOnly: false, // JSから読めるように（iframeで必要）
      secure: true,
      sameSite: 'none',
    })
  }

  return response
}
