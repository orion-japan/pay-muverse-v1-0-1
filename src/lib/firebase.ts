// src/lib/firebase.ts
import { initializeApp, getApps, getApp, setLogLevel } from 'firebase/app';
import { getAuth } from 'firebase/auth';

// ✅ Firebaseの環境変数
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// ✅ 二重初期化防止（Next.js環境対策）
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

// ✅ Firebase Authエクスポート
export const auth = getAuth(app);

// ✅ デバッグ時のみ SDK ログを出す
if (process.env.NEXT_PUBLIC_DEBUG_LOCAL === '1') {
  // Firebase SDK 全体の内部ログを出力
  setLogLevel('debug');
  console.log('[firebase] DEBUG_LOCAL=1 → Firebase SDK log level set to "debug"');
}
