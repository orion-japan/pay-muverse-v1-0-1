// src/lib/firebase-admin.ts
import {
  initializeApp,
  getApps,
  cert,
  applicationDefault,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

/** .env に入れた秘密鍵の改行(\n)復元＋両端の余計なダブルクォート除去 */
function cleanupPrivateKey(v: string) {
  return v.replace(/\\n/g, '\n').replace(/^\s*"|"\s*$/g, '');
}

/** 環境変数から ServiceAccount を生成（3通りの入力形式に対応） */
function resolveCredentials(): ServiceAccount | null {
  // projectId は公開可なので NEXT_PUBLIC/FIREBASE のどちらでも受ける
  const projectId =
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    process.env.FIREBASE_PROJECT_ID ||
    '';

  // ① 推奨: 個別3変数（.env で直接指定）
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

  // 何もなければ null（applicationDefault にフォールバック）
  return null;
}

/* ---- 初期化（1回だけ） ---- */
if (!getApps().length) {
  const cred = resolveCredentials();
  if (cred) {
    initializeApp({ credential: cert(cred) });
    console.log('[firebase-admin] initialized with ServiceAccount');
  } else {
    // gcloud auth application-default login などの ADC を利用
    initializeApp({ credential: applicationDefault() });
    console.log('[firebase-admin] initialized with applicationDefault()');
  }
}

/** 以降はどこから import しても同じインスタンス */
export const adminAuth = getAuth();
