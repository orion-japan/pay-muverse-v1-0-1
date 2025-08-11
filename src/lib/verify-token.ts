import { adminAuth } from './firebase-admin'
import { NextRequest } from 'next/server'

export async function verifyFirebaseToken(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const token = authHeader?.replace(/^Bearer\s+/i, '')

  if (!token) {
    throw new Error('トークンがありません')
  }

  try {
    const decoded = await adminAuth.verifyIdToken(token, true) // 最新状態で検証
    return {
      uid: decoded.uid,
      email: decoded.email || null,
      emailVerified: decoded.email_verified === true,
    }
  } catch (err) {
    console.error('❌ Firebaseトークン検証失敗:', err)
    throw new Error('無効なトークンです')
  }
}
