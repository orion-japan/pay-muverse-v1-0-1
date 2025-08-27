'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  onAuthStateChanged,
  onIdTokenChanged,
  getIdToken,
  setPersistence,
  browserLocalPersistence,
  User,
  signOut,
} from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { supabase } from '@/lib/supabase';

/* =========================================================
   型
========================================================= */
type Plan = 'free' | 'regular' | 'premium' | 'master' | 'admin';

type AuthValue = {
  loading: boolean;
  user: User | null;        // Firebaseのユーザー情報
  idToken: string | null;   // Firebase IDトークン（最新を番犬が更新）
  userCode: string | null;  // 数値ユーザーコード
  planStatus: Plan;         // プラン
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthValue>({
  loading: true,
  user: null,
  idToken: null,
  userCode: null,
  planStatus: 'free',
  logout: async () => {},
});

/* =========================================================
   ユーティリティ
========================================================= */
/** /api/resolve-usercode から user_code を解決（POST → 404ならGET） */
async function fetchUserCodeFromServer(u: User): Promise<string | null> {
  const url = '/api/resolve-usercode';
  try {
    let res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: u.uid, email: u.email ?? null }),
    });
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

/** profiles.plan_status を取得（未知/欠損は free 扱い） */
async function fetchPlanStatus(userCode: string): Promise<Plan> {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('plan_status')
      .eq('user_code', userCode)
      .maybeSingle();

    if (error) throw error;
    const v = String(data?.plan_status ?? 'free').toLowerCase();
    return (['free', 'regular', 'premium', 'master', 'admin'].includes(v) ? v : 'free') as Plan;
  } catch (e) {
    console.warn('[AuthContext] fetchPlanStatus error', e);
    return 'free';
  }
}

/* =========================================================
   Provider（番犬つき）
========================================================= */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [planStatus, setPlanStatus] = useState<Plan>('free');
  const [loading, setLoading] = useState(true);

  /* --- 永続化（ブラウザ閉じても維持） --- */
  useEffect(() => {
    setPersistence(auth, browserLocalPersistence).catch((err) => {
      console.error('[AuthContext] Failed to set persistence', err);
    });
  }, []);

  /* --- onAuthStateChanged: サインイン/アウト検知 --- */
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        setUser(u);

        if (!u) {
          // クリア
          setIdToken(null);
          setUserCode(null);
          setPlanStatus('free');
          if (typeof window !== 'undefined') localStorage.removeItem('user_code');
          return;
        }

        // 初回は強制更新で鮮度の高いトークンを取得
        try {
          const token = await getIdToken(u, true);
          setIdToken(token);
        } catch (e) {
          console.error('[AuthContext] getIdToken(true) error', e);
          setIdToken(null);
        }

        // user_code は localStorage → API の順で解決
        const cached = typeof window !== 'undefined' ? localStorage.getItem('user_code') : null;
        if (cached) {
          setUserCode(cached);
        } else {
          const code = await fetchUserCodeFromServer(u);
          if (code) {
            setUserCode(code);
            if (typeof window !== 'undefined') localStorage.setItem('user_code', code);
          } else {
            setUserCode(null);
            if (typeof window !== 'undefined') localStorage.removeItem('user_code');
          }
        }
      } finally {
        setLoading(false);
      }
    });

    // 念のためのフェイルセーフ
    const failSafe = setTimeout(() => setLoading(false), 5000);
    return () => {
      unsub();
      clearTimeout(failSafe);
    };
  }, []);

  /* --- onIdTokenChanged: トークン自動更新を即時反映（番犬の目） --- */
  useEffect(() => {
    const off = onIdTokenChanged(auth, async (u) => {
      if (!u) {
        setIdToken(null);
        return;
      }
      try {
        // キャッシュでもOK（ここは頻繁に呼ばれるため）
        const token = await getIdToken(u, false);
        setIdToken(token);
      } catch (e) {
        console.warn('[AuthContext] onIdTokenChanged getIdToken error', e);
      }
    });
    return () => off();
  }, []);

  /* --- 番犬: 45分ごとに強制リフレッシュ（±2分のジッタ） --- */
  useEffect(() => {
    const base = 45 * 60 * 1000;
    const jitter = Math.floor(Math.random() * 2 * 60 * 1000); // 0〜2分
    const iv = setInterval(async () => {
      const u = auth.currentUser;
      if (!u) return;
      try {
        await getIdToken(u, true); // 強制更新
      } catch (e) {
        console.warn('[AuthContext] periodic refresh failed', e);
      }
    }, base + jitter);
    return () => clearInterval(iv);
  }, []);

  /* --- userCode が決まったらプラン取得 --- */
  useEffect(() => {
    if (!userCode) {
      setPlanStatus('free');
      return;
    }
    let alive = true;
    (async () => {
      const plan = await fetchPlanStatus(userCode);
      if (alive) setPlanStatus(plan);
    })();
    return () => {
      alive = false;
    };
  }, [userCode]);

  /* --- ログアウト --- */
  const logout = async () => {
    try {
      await signOut(auth);
    } finally {
      setUser(null);
      setIdToken(null);
      setUserCode(null);
      setPlanStatus('free');
      if (typeof window !== 'undefined') localStorage.removeItem('user_code');
    }
  };

  const value = useMemo(
    () => ({ loading, user, idToken, userCode, planStatus, logout }),
    [loading, user, idToken, userCode, planStatus]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/* =========================================================
   Hook
========================================================= */
export function useAuth() {
  return useContext(AuthContext);
}

/* =========================================================
   おまけ：共通フェッチ（401/403を一度だけ自己回復）
   - 使い方: authedFetch('/api/xxx', { method: 'POST', body: ... })
   - Context を汚さないため別エクスポートにしています
========================================================= */
export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const retry = async (force: boolean) => {
    const u = auth.currentUser;
    if (!u) throw new Error('AUTH_NO_USER');
    const token = await getIdToken(u, force);
    const res = await fetch(input, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
    return res;
  };

  let res = await retry(false);
  if (res.status === 401 || res.status === 403) {
    // 強制更新してワンチャン
    res = await retry(true);
  }
  if (res.status === 401 || res.status === 403) {
    // 依然として失敗 → 破損セッションと見なしてサインアウト
    try { await signOut(auth); } catch {}
    throw new Error('AUTH_EXPIRED');
  }
  return res;
}
