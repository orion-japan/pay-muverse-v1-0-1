'use client';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  onAuthStateChanged,
  onIdTokenChanged,            // ★ 追加：トークン自動更新イベント
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
  logout: () => Promise<void>; // 👈 既存APIを維持
};

const AuthContext = createContext<AuthValue>({
  loading: true,
  user: null,
  idToken: null,
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 永続化（リロードで currentUser が消えにくくする）
    setPersistence(auth, browserLocalPersistence).catch(() => { /* noop */ });

    // ① サインイン状態の変化を監視
    const unsubAuth = onAuthStateChanged(auth, async (u) => {
      try {
        setUser(u);
        if (u) {
          // 初回は強制更新で確実に取得
          const token = await getIdToken(u, /* forceRefresh */ true);
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

    // ② idToken 自動更新のたびに反映（期限切れや権限変更に追従）
    const unsubToken = onIdTokenChanged(auth, async (u) => {
      if (!u) {
        setIdToken(null);
        return;
      }
      try {
        const token = await getIdToken(u, /* forceRefresh */ false);
        setIdToken(token);
      } catch (e) {
        console.error('[AuthContext] onIdTokenChanged error', e);
      }
    });

    // 起動失敗のフェイルセーフ
    const failSafe = setTimeout(() => setLoading(false), 5000);

    return () => {
      unsubAuth();
      unsubToken();
      clearTimeout(failSafe);
    };
  }, []);

  // ログアウト
  const logout = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error('[AuthContext] logout error:', err);
    } finally {
      setUser(null);
      setIdToken(null);
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
