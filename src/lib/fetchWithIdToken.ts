'use client';
import { getAuth } from 'firebase/auth';

/** Firebase IDトークンを自動付与する共通fetch */
export async function fetchWithIdToken(url: string, init: RequestInit = {}) {
  const auth = getAuth();
  const user = auth.currentUser;
  const idToken = await user?.getIdToken();
  if (!idToken) throw new Error('Firebase ID token not found (not signed in?)');

  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${idToken}`);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, { ...init, headers });
}
