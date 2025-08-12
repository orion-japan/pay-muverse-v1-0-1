// src/lib/firebase-admin.ts
import { initializeApp, getApps, cert, ServiceAccount } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function resolveCredentials(): ServiceAccount {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

  // 推奨: 直指定（.env の3行）
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
  if (clientEmail && privateKeyRaw && projectId) {
    return { 
      projectId, 
      clientEmail, 
      privateKey: privateKeyRaw.replace(/\\n/g, '\n') 
    };
  }

  // 互換: JSON 文字列（FIREBASE_SERVICE_ACCOUNT_KEY）でもOK
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (json) {
    const obj = JSON.parse(json);
    return {
      projectId: obj.project_id,
      clientEmail: obj.client_email,
      privateKey: String(obj.private_key).replace(/\\n/g, '\n'),
    };
  }

  // 互換: BASE64（FIREBASE_ADMIN_KEY_BASE64）でもOK
  const b64 = process.env.FIREBASE_ADMIN_KEY_BASE64;
  if (b64) {
    const obj = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return {
      projectId: obj.project_id,
      clientEmail: obj.client_email,
      privateKey: String(obj.private_key).replace(/\\n/g, '\n'),
    };
  }

  throw new Error(
    'Firebase Admin credentials are missing. Set FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, and NEXT_PUBLIC_FIREBASE_PROJECT_ID (or JSON/BASE64).'
  );
}

if (!getApps().length) {
  const cred = resolveCredentials();
  initializeApp({ credential: cert(cred) });
}

export const adminAuth = getAuth();
