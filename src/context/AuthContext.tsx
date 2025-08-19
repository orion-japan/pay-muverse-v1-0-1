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
import { auth } from '@/lib/firebase'; // Firebase クライアント初期化
import { supabase } from '@/lib/supabase'; // ✅ Supabase 追加

type AuthValue = {
  loading: boolean;
  user: User | null;
  idToken: string | null;
  userCode: string | null; // ✅ 追加
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthValue>({
  loading: true,
  user: null,
  idToken: null,
  userCode: null, // ✅ 追加
  logout: async () => {}, // ダミー関数
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null); // ✅ 追加
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setPersistence(auth, browserLocalPersistence).catch(() => {});

    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        setUser(u);

        if (u) {
          const token = await getIdToken(u, true);
          setIdToken(token);

          // ✅ Supabase から user_code を取得
          const { data, error } = await supabase
            .from('users')
            .select('user_code')
            .eq('firebase_uid', u.uid)
            .maybeSingle();

          if (data?.user_code) {
            setUserCode(data.user_code);
          } else {
            setUserCode(null);
            console.warn('[AuthContext] user_code not found:', error?.message);
          }
        } else {
          setIdToken(null);
          setUserCode(null);
        }
      } catch (e) {
        console.error('[AuthContext] getIdToken error', e);
        setIdToken(null);
        setUserCode(null);
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
      setUser(null);
      setIdToken(null);
      setUserCode(null); // ✅ ログアウト時に userCode をクリア
    } catch (err) {
      console.error('[AuthContext] logout error:', err);
    }
  };

  const value = useMemo(
    () => ({ loading, user, idToken, logout, userCode }), // ✅ userCode を追加
    [loading, user, idToken, userCode]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
