import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

// ✅ .env.local の環境変数からサービスアカウントJSONを取得
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY

if (!serviceAccountJson) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY が .env.local に設定されていません')
}

let serviceAccount

try {
  serviceAccount = JSON.parse(serviceAccountJson)
  // 🔧 改行を復元（\n → 改行文字）
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n')
} catch (err) {
  console.error('❌ サービスアカウントJSONのパースに失敗しました:', err)
  throw err
}

// ✅ Firebase Admin SDK 初期化
const app = !getApps().length
  ? initializeApp({ credential: cert(serviceAccount) })
  : getApp()

// ✅ 認証オブジェクトをエクスポート
export const adminAuth = getAuth(app)
