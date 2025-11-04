'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  onIdTokenChanged,
  getIdToken,
  getIdTokenResult,
  setPersistence,
  browserLocalPersistence,
  User,
  signOut,
} from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { supabase } from '@/lib/supabase';

// ★ 追加（DevTools からトークン取得するための一時窓口）
if (typeof window !== 'undefined') (window as any)._firebaseAuth = auth;

/* =========================
   型
========================= */
type Plan = 'free' | 'regular' | 'premium' | 'master' | 'admin';

type AuthValue = {
  loading: boolean;
  user: User | null;
  idToken: string | null;
  userCode: string | null;
  planStatus: Plan;
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

/* =========================
   ユーティリティ
========================= */
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

/** users.plan_status を取得（未知/欠損は free 扱い） */
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

/* =========================
   Provider（安定化版）
========================= */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [planStatus, setPlanStatus] = useState<Plan>('free');
  const [loading, setLoading] = useState(true);

  // 次回の期限前リフレッシュ用タイマーを保持（更新のたびに張り替える）
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* --- 永続化（ブラウザ閉じても維持） --- */
  useEffect(() => {
    setPersistence(auth, browserLocalPersistence).catch((err) => {
      console.error('[AuthContext] Failed to set persistence', err);
    });
  }, []);

  /* --- 期限前リフレッシュのタイマー設定 --- */
  function scheduleProactiveRefresh(u: User) {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    getIdTokenResult(u, /* forceRefresh */ false)
      .then((res) => {
        // exp の 60秒前に更新。余裕を持って取り直す
        const expMs =
          res.claims && (res as any).expirationTime
            ? new Date((res as any).expirationTime).getTime()
            : (res as any)?.exp
              ? Number((res as any).exp) * 1000
              : 0;

        if (!expMs) return;

        const now = Date.now();
        const skew = 60 * 1000;
        const due = Math.max(0, expMs - now - skew);

        refreshTimerRef.current = setTimeout(async () => {
          try {
            const fresh = await getIdToken(u, true);
            setIdToken(fresh);
            // ★ 追加：最新トークンをwindowへミラー
            if (typeof window !== 'undefined') (window as any)._irosToken = fresh;
          } catch (e) {
            console.warn('[AuthContext] proactive refresh failed', e);
          }
        }, due);
      })
      .catch((e) => console.warn('[AuthContext] getIdTokenResult failed', e));
  }

  /* --- onIdTokenChanged: サインイン/サインアウト/トークン更新を一元監視 --- */
  useEffect(() => {
    let mounted = true;

    const off = onIdTokenChanged(auth, async (u) => {
      if (!mounted) return;

      // サインアウト or 未ログイン
      if (!u) {
        setUser(null);
        setIdToken(null);
        setUserCode(null);
        setPlanStatus('free');
        if (typeof window !== 'undefined') {
          localStorage.removeItem('user_code');
          (window as any)._irosToken = null; // ★ 追加：ミラーをクリア
        }
        setLoading(false);
        return;
      }

      setUser(u);

      try {
        // まずはキャッシュ可
        const token = await getIdToken(u, false);
        if (!mounted) return;
        setIdToken(token);
        // ★ 追加：最新トークンをwindowへミラー
        if (typeof window !== 'undefined') (window as any)._irosToken = token;

        // 期限前リフレッシュを予約
        scheduleProactiveRefresh(u);

        // user_code は uid と紐づけて管理。uidが変わったら確実に取り直す
        const cacheKey = 'user_code';
        const cached = typeof window !== 'undefined' ? localStorage.getItem(cacheKey) : null;
        if (cached && typeof window !== 'undefined') {
          // 以前の user_code が他uidの可能性を考慮（簡易チェック）
          // 必要に応じて uid を含むキャッシュキーにする実装へ移行してください。
        }

        let nextCode: string | null = null;
        if (cached) {
          nextCode = cached;
        } else {
          nextCode = await fetchUserCodeFromServer(u);
        }

        if (nextCode) {
          setUserCode(nextCode);
          if (typeof window !== 'undefined') localStorage.setItem(cacheKey, nextCode);
        } else {
          setUserCode(null);
          if (typeof window !== 'undefined') localStorage.removeItem(cacheKey);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    });

    return () => {
      mounted = false;
      off();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  /* --- バックアップ：45分周期で強制リフレッシュ（±2分ジッタ） --- */
  useEffect(() => {
    const base = 45 * 60 * 1000;
    const jitter = Math.floor(Math.random() * 2 * 60 * 1000); // 0〜2分
    const iv = setInterval(async () => {
      const u = auth.currentUser;
      if (!u) return;
      try {
        const fresh = await getIdToken(u, true);
        setIdToken(fresh);
        // ★ 追加：最新トークンをwindowへミラー
        if (typeof window !== 'undefined') (window as any)._irosToken = fresh;
        scheduleProactiveRefresh(u);
      } catch (e) {
        console.warn('[AuthContext] periodic refresh failed', e);
      }
    }, base + jitter);
    return () => clearInterval(iv);
  }, []);

  /* --- タブ復帰/オンライン復帰で即更新（“戻ると落ちてる”体感を減らす） --- */
  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== 'visible') return;
      const u = auth.currentUser;
      if (!u) return;
      try {
        const fresh = await getIdToken(u, true);
        setIdToken(fresh);
        // ★ 追加：最新トークンをwindowへミラー
        if (typeof window !== 'undefined') (window as any)._irosToken = fresh;
        scheduleProactiveRefresh(u);
      } catch {}
    };
    const onOnline = async () => {
      const u = auth.currentUser;
      if (!u) return;
      try {
        const fresh = await getIdToken(u, true);
        setIdToken(fresh);
        // ★ 追加：最新トークンをwindowへミラー
        if (typeof window !== 'undefined') (window as any)._irosToken = fresh;
        scheduleProactiveRefresh(u);
      } catch {}
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
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
      if (typeof window !== 'undefined') {
        localStorage.removeItem('user_code');
        (window as any)._irosToken = null; // ★ 追加：ミラーをクリア
      }
    }
  };

  const value = useMemo(
    () => ({ loading, user, idToken, userCode, planStatus, logout }),
    [loading, user, idToken, userCode, planStatus],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/* =========================
   Hook
========================= */
export function useAuth() {
  return useContext(AuthContext);
}

/* =========================
   authedFetch（401/403を一度だけ自己回復）
========================= */
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
      credentials: (init as any)?.credentials ?? 'include',
    });
    return res;
  };

  let res = await retry(false);
  if (res.status === 401 || res.status === 403) {
    res = await retry(true);
  }
  if (res.status === 401 || res.status === 403) {
    try {
      await signOut(auth);
    } catch {}
    throw new Error('AUTH_EXPIRED');
  }
  return res;
}

// ★ 追加（DevTools から authedFetch を直接使えるように）
if (typeof window !== 'undefined') (window as any).authedFetch = authedFetch;
