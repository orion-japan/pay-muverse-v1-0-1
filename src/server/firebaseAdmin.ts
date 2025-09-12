// src/server/firebaseAdmin.ts
import { initializeApp, applicationDefault, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function resolveProjectId(): string | undefined {
  return process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || undefined;
}

export function ensureFirebaseAdmin() {
  if (getApps().length) return;
  const projectId = resolveProjectId();

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (clientEmail && privateKey && projectId) {
    initializeApp({ credential: cert({ clientEmail, privateKey, projectId }) });
  } else {
    // ADC 環境変数やローカル gcloud を利用。projectId を明示しておく。
    initializeApp({ credential: applicationDefault(), ...(projectId ? { projectId } : {}) });
  }
}

export function adminAuth() {
  ensureFirebaseAdmin();
  return getAuth();
}
