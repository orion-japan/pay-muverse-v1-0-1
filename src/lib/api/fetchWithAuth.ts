// fetchWithAuth.ts
import { getAuth } from 'firebase/auth';
import { initializeApp, getApps } from 'firebase/app';

// Firebase 初期化（App 重複作成を防止）
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
};

if (!getApps().length) {
  initializeApp(firebaseConfig);
}

export async function fetchWithAuth(
  input: RequestInfo | URL,
  init?: RequestInit & { noAuth?: boolean },
) {
  const opts: RequestInit = { ...(init || {}) };
  const headers = new Headers(opts.headers || {});

  // noAuth 指定時は Authorization を付けない
  if (!init?.noAuth) {
    const auth = getAuth();
    const user = auth.currentUser;
    const idToken = user ? await user.getIdToken(/* forceRefresh? */ false) : null;
    if (idToken) headers.set('Authorization', `Bearer ${idToken}`);
  }
  if (!headers.has('content-type') && !(opts.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }
  opts.headers = headers;

  return fetch(input, opts);
}
