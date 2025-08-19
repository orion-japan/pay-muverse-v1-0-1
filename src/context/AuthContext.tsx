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
import { auth } from '@/lib/firebase'; // 既存の初期化を利用

type AuthValue = {
  loading: boolean;
  user: User | null;
  idToken: string | null;
  logout: () => Promise<void>; // 👈 追加
};

const AuthContext = createContext<AuthValue>({
  loading: true,
  user: null,
  idToken: null,
  logout: async () => {}, // ダミー
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setPersistence(auth, browserLocalPersistence).catch(() => { /* noop */ });

    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        setUser(u);
        if (u) {
          const token = await getIdToken(u, true);
          setIdToken(token);
        } else {
          setIdToken(null);
        }
      } catch (e) {
        console.error('[AuthContext] getIdToken error', e);
        setIdToken(null);
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

  // 👇 ここで signOut をラップ
  const logout = async () => {
    try {
      await signOut(auth);
      setUser(null);
      setIdToken(null);
    } catch (err) {
      console.error('[AuthContext] logout error:', err);
    }
  };

  const value = useMemo(
    () => ({ loading, user, idToken, logout }),
    [loading, user, idToken]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
