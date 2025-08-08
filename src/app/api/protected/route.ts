import { NextRequest, NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin' // ✅ 修正済

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const token = authHeader?.replace(/^Bearer\s+/i, '') // ✅ より安全なパース

  if (!token) {
    return NextResponse.json({ error: 'トークンがありません' }, { status: 401 })
  }

  try {
    const decoded = await adminAuth.verifyIdToken(token)

    const uid = decoded.uid
    const email = decoded.email
    const emailVerified = decoded.email_verified

    return NextResponse.json({
      uid,
      email,
      emailVerified,
    })
  } catch (err) {
    console.error('❌ トークン検証エラー:', err)
    return NextResponse.json({ error: 'トークンの検証に失敗しました' }, { status: 403 })
  }
}
