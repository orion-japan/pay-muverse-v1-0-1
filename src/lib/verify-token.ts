import { adminAuth } from './firebase-admin'
import { NextRequest } from 'next/server'

export async function verifyFirebaseToken(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const token = authHeader?.replace(/^Bearer\s+/i, '')

  if (!token) {
    throw new Error('トークンがありません')
  }

  const decoded = await adminAuth.verifyIdToken(token)
  return decoded
}
