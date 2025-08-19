// src/lib/firebase-admin.ts
import { initializeApp, getApps, cert, type ServiceAccount } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function cleanupPrivateKey(v: string) {
  // .env での改行(\n)復元＋余計な両端のダブルクォート除去
  return v.replace(/\\n/g, '\n').replace(/^\s*"|"\s*$/g, '');
}

function resolveCredentials(): ServiceAccount {
  // projectId は公開可なので NEXT_PUBLIC/FIREBASE のどちらでも受ける
  const projectId =
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || '';

  // ① 推奨: 3変数直指定
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY || '';
  if (projectId && clientEmail && privateKeyRaw) {
    return {
      projectId,
      clientEmail,
      privateKey: cleanupPrivateKey(privateKeyRaw),
    };
  }

  // ② JSON 文字列（FIREBASE_SERVICE_ACCOUNT_KEY）
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (json) {
    try {
      const obj = JSON.parse(json);
      return {
        projectId: obj.project_id,
        clientEmail: obj.client_email,
        privateKey: cleanupPrivateKey(String(obj.private_key || '')),
      };
    } catch (e) {
      console.warn('[firebase-admin] Invalid FIREBASE_SERVICE_ACCOUNT_KEY JSON:', e);
    }
  }

  // ③ BASE64（FIREBASE_ADMIN_KEY_BASE64）
  const b64 = process.env.FIREBASE_ADMIN_KEY_BASE64;
  if (b64) {
    try {
      const obj = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      return {
        projectId: obj.project_id,
        clientEmail: obj.client_email,
        privateKey: cleanupPrivateKey(String(obj.private_key || '')),
      };
    } catch (e) {
      console.warn('[firebase-admin] Invalid FIREBASE_ADMIN_KEY_BASE64:', e);
    }
  }

  throw new Error(
    '[firebase-admin] Missing credentials. ' +
      'Set FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, and (NEXT_PUBLIC_)FIREBASE_PROJECT_ID ' +
      'or provide FIREBASE_SERVICE_ACCOUNT_KEY / FIREBASE_ADMIN_KEY_BASE64.'
  );
}

// ここで一度だけ Admin を初期化
if (!getApps().length) {
  const cred = resolveCredentials();
  initializeApp({ credential: cert(cred) });
}

// 以降はどこから import しても同じインスタンス
export const adminAuth = getAuth();
