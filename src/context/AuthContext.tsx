'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  onAuthStateChanged,
  getIdToken,
  setPersistence,
  browserLocalPersistence,
  User,
  signOut,
} from 'firebase/auth';
import { auth } from '@/lib/firebase';

type AuthValue = {
  loading: boolean;
  user: User | null;        // Firebaseのユーザー情報
  idToken: string | null;   // Firebase IDトークン
  userCode: string | null;  // Supabase/独自のユーザーコード
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthValue>({
  loading: true,
  user: null,
  idToken: null,
  userCode: null,
  logout: async () => {},
});

/** user_code を API 経由で取得する */
async function fetchUserCodeFromServer(u: User): Promise<string | null> {
  const url = '/api/resolve-usercode';
  try {
    // ① POST
    let res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: u.uid, email: u.email ?? null }),
    });

    // 404 フォールバックで ② GET
    if (res.status === 404) {
      const qs = new URLSearchParams();
      if (u.uid) qs.set('uid', u.uid);
      if (u.email) qs.set('email', u.email);
      res = await fetch(`${url}?${qs.toString()}`, { method: 'GET' });
    }

    if (!res.ok) return null;
    const json = (await res.json()) as { user_code?: string | null; ok?: boolean };
    if (json.ok && !('user_code' in json)) return null; // ping応答
    return json.user_code ?? null;
  } catch (e) {
    console.error('[AuthContext] resolve-usercode API error', e);
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setPersistence(auth, browserLocalPersistence).catch((err) => {
      console.error('[AuthContext] Failed to set persistence', err);
    });

    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        setUser(u);

        if (!u) {
          setIdToken(null);
          setUserCode(null);
          if (typeof window !== 'undefined') localStorage.removeItem('user_code');
          return;
        }

        try {
          const token = await getIdToken(u, true);
          setIdToken(token);
        } catch (e) {
          console.error('[AuthContext] getIdToken error', e);
          setIdToken(null);
        }

        // localStorage からキャッシュ利用
        const cached = typeof window !== 'undefined' ? localStorage.getItem('user_code') : null;
        if (cached) {
          console.log('[AuthContext] use localStorage user_code:', cached);
          setUserCode(cached);
          return;
        }

        // API から取得
        const code = await fetchUserCodeFromServer(u);
        if (code) {
          console.log('[AuthContext] user_code resolved:', code);
          setUserCode(code);
          if (typeof window !== 'undefined') localStorage.setItem('user_code', code);
        } else {
          console.warn('[AuthContext] user_code not found in any source');
          setUserCode(null);
          if (typeof window !== 'undefined') localStorage.removeItem('user_code');
        }
      } finally {
        setLoading(false);
      }
    });

    const failSafe = setTimeout(() => setLoading(false), 5000);
    return () => {
      unsub();
      clearTimeout(failSafe);
    };
  }, []);

  const logout = async () => {
    try {
      await signOut(auth);
    } finally {
      setUser(null);
      setIdToken(null);
      setUserCode(null);
      if (typeof window !== 'undefined') localStorage.removeItem('user_code');
    }
  };

  const value = useMemo(
    () => ({ loading, user, idToken, userCode, logout }),
    [loading, user, idToken, userCode]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
