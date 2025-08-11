import { adminAuth } from '@/lib/firebase-admin'

/**
 * Firebase IDトークンを検証してUIDとメール情報を返す
 * @param token クライアントから送られたFirebase IDトークン
 * @returns { uid: string, email?: string, emailVerified?: boolean }
 * @throws 無効なトークンや検証エラー時は例外を投げる
 */
export async function verifyFirebaseToken(token: string) {
  if (!token) {
    throw new Error('Firebase IDトークンが必要です')
  }

  try {
    const decoded = await adminAuth.verifyIdToken(token, true)
    return {
      uid: decoded.uid,
      email: decoded.email,
      emailVerified: decoded.email_verified,
    }
  } catch (err) {
    console.error('❌ Firebaseトークン検証失敗:', err)
    throw new Error('無効なトークンです')
  }
}
