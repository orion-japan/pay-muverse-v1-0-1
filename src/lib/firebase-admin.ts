// src/lib/firebase-admin.ts
import {
  initializeApp,
  getApps,
  cert,
  applicationDefault,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

/** 実行環境判定 */
const isBrowser = typeof window !== 'undefined';
const isEdgeRuntime =
  // Next.js Edge Runtime では EdgeRuntime グローバルが定義される
  typeof (globalThis as any).EdgeRuntime !== 'undefined' ||
  process.env.NEXT_RUNTIME === 'edge';

/** .env に入れた秘密鍵の改行(\n)復元＋両端の余計なダブルクォート除去 */
function cleanupPrivateKey(v: string) {
  // \n / \r\n の両対応
  return v.replace(/\\r?\\n/g, '\n').replace(/^\s*"|"\s*$/g, '');
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

  // ② BASE64（FIREBASE_ADMIN_KEY_BASE64） ← ★優先順を前に移動
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

  // ③ JSON 文字列（FIREBASE_SERVICE_ACCOUNT_KEY） ← ★後ろに移動
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

  // 何もなければ null（applicationDefault にフォールバック）
  return null;
}

/* ---- 初期化（1回だけ） ----
   - クライアントや Edge Runtime で import されても落ちないようにスキップ
   - Node.js サーバ環境でのみ初期化を実施
*/
if (!isBrowser && !isEdgeRuntime && !getApps().length) {
  const cred = resolveCredentials();
  if (cred) {
    initializeApp({ credential: cert(cred) });
    console.log('[firebase-admin] initialized with ServiceAccount');
  } else {
    // gcloud auth application-default login などの ADC を利用
    initializeApp({ credential: applicationDefault() });
    console.log('[firebase-admin] initialized with applicationDefault()');
  }
} else if (isEdgeRuntime) {
  // Edge では Admin SDK は使えない。ページ側で runtime='nodejs' を指定してください。
  console.warn(
    '[firebase-admin] skipped initialization on Edge Runtime (set `export const runtime = "nodejs"` on the page or route).'
  );
}

/** 以降はどこから import しても同じインスタンス
 *  Edge / ブラウザで誤って参照された場合でも import 時に落ちないよう try/catch
 */
let _auth: ReturnType<typeof getAuth> | undefined;
try {
  _auth = getAuth();
} catch {
  // Edge/Browser など未初期化環境では、参照時に分かりやすいメッセージを投げる
  Object.defineProperty(globalThis, '__FIREBASE_ADMIN_AUTH_ERROR__', {
    value: true,
    configurable: true,
  });
  _auth = undefined as unknown as ReturnType<typeof getAuth>;
}

export const adminAuth = _auth;
