'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';

const FOOTER_H = 60 as const;

// =====================
// ログユーティリティ
// =====================
const TAG = '[iros]';
let runId = 0;
const now = () => Math.round(performance.now());
const log = (...args: any[]) => console.log(`${TAG}#${runId}`, ...args);
const group = (t: string) => console.groupCollapsed(`${TAG}#${runId} ${t}`);
const groupEnd = () => console.groupEnd();

// /iros は SOFIA 固定
const TENANT: 'sofia' = 'sofia';
const SOFIA_UI_URL = (process.env.NEXT_PUBLIC_SOFIA_UI_URL ?? 'https://s.muverse.jp').replace(
  /\/+$/,
  '',
);
const TARGET_UI_URL = SOFIA_UI_URL;

type UserRole = 'free' | 'member' | 'pro' | 'master' | 'admin' | string;

export default function IrosPage() {
  const { user, loading } = useAuth();
  const [role, setRole] = useState<UserRole | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const startedAtRef = useRef<number>(0);
  const router = useRouter();

  // 初期ログ
  useEffect(() => {
    runId += 1;
    startedAtRef.current = now();
    group('Init');
    log('TENANT =', TENANT);
    log('ENV:', {
      NEXT_PUBLIC_SOFIA_UI_URL: process.env.NEXT_PUBLIC_SOFIA_UI_URL,
      resolved: { SOFIA_UI_URL, TARGET_UI_URL },
    });
    groupEnd();
  }, []);

  // click_type を API から取得
  useEffect(() => {
    if (loading) return;
    if (!user) return;

    let cancelled = false;

    (async () => {
      try {
        const idToken = await user.getIdToken(true);
        const res = await fetch('/api/get-user-info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ idToken }),
          cache: 'no-store',
        });
        const j = await res.json().catch(() => ({}));
        const ct: UserRole | null = j?.user?.click_type ?? j?.click_type ?? null;
        if (!cancelled) {
          log('fetched click_type =', ct);
          if (ct) setRole(ct);
          else setRole('free'); // 取得失敗時は安全側で弾く
        }
      } catch (e) {
        if (!cancelled) {
          log('click_type fetch failed', e);
          setRole('free'); // 安全側
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loading, user]);

  // ===== アクセス制御（最優先） =====
  useEffect(() => {
    if (loading) return;

    if (!user) {
      setError('ログインが必要です');
      router.replace('/');
      return;
    }
    if (!role) return;

    const allowed = role === 'master' || role === 'admin';
    log('role check:', { role, allowed });

    if (!allowed) {
      router.replace('/');
    }
  }, [loading, user, role, router]);
  // ===================================

  const userBrief = useMemo(
    () => (user ? { uid: user.uid, email: user.email ?? null } : null),
    [user],
  );

  // 権限OKになってから iFrame URL を準備
  useEffect(() => {
    const allowed = role === 'master' || role === 'admin';
    if (loading || !user || !allowed) return;

    const start = async () => {
      group('Start iros flow');
      log('Auth state:', { loading, hasUser: !!user, user: userBrief });

      try {
        const t0 = now();
        log('🔐 getIdToken(true) …');
        const idToken = await user.getIdToken(true);
        log('🔐 got idToken length =', idToken?.length ?? 0, `(+${now() - t0}ms)`);
        if (!idToken) throw new Error('IDトークン取得失敗');

        // ===== /api/resolve-so 呼び出し =====
        const t1 = now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        log('📡 fetch /api/resolve-so');

        const res = await fetch('/api/resolve-so', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
          cache: 'no-store',
          signal: controller.signal,
        });

        clearTimeout(timer);
        log('📨 /api/resolve-so status =', res.status, `(+${now() - t1}ms)`);
        const json: any = await res
          .clone()
          .json()
          .catch(() => ({}));

        group('resolve-so payload');
        log('ok =', json?.ok);
        log('tenant =', json?.tenant);
        log('user_code =', json?.user_code);
        log('login_url =', json?.login_url);
        groupEnd();

        if (!res.ok || !json?.ok)
          throw new Error(json?.error || `RESOLVE_FAILED (HTTP ${res.status})`);

        const loginUrl: string | undefined = json?.login_url;
        const userCode: string | undefined = json?.user_code;

        // ① ベースURL（login_url 優先、なければフォールバック）
        let base = loginUrl;
        if (!base) {
          if (!userCode) throw new Error('署名付きURLが取得できませんでした');
          base =
            `${TARGET_UI_URL}${TARGET_UI_URL.includes('?') ? '&' : '?'}` +
            `user=${encodeURIComponent(userCode)}`;
        }
        log('🧭 base url (before force) =', base);

        // ② 必ず SOFIA を向ける
        let finalUrl = '';
        try {
          const u = new URL(base);
          const sofiaHost = new URL(SOFIA_UI_URL).host;
          if (u.host !== sofiaHost)
            log('⚠️ host force → SOFIA', { before: u.host, after: sofiaHost });
          u.protocol = 'https:';
          u.host = sofiaHost;
          // ③ iFrame用オプション
          u.searchParams.set('hideHeader', '1');
          u.searchParams.set('from', 'so');
          finalUrl = u.toString();
          log('🎯 final iframe url =', finalUrl);
        } catch (e) {
          log('URL parse failed for base=', base, e);
          finalUrl = `${SOFIA_UI_URL}?hideHeader=1&from=so`;
        }

        setUrl(finalUrl);
        log('✅ setUrl() done');
      } catch (e: any) {
        const msg = e?.message || '不明なエラー';
        log('❌ error:', msg, e);
        setError(msg);
      } finally {
        log('⏱ total +', now() - startedAtRef.current, 'ms');
        groupEnd();
      }
    };

    start();
  }, [loading, user, userBrief, role]);

  // --------- 描画 ----------
  if (loading || !user || !role) {
    return (
      <div
        style={{
          height: `calc(100dvh - ${FOOTER_H}px)`,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        認証確認中…
      </div>
    );
  }

  const allowed = role === 'master' || role === 'admin';
  if (!allowed) {
    // router.replace('/') 済み。白フラッシュ回避のため描画しない
    return null;
  }

  if (error) {
    return (
      <div
        style={{
          height: `calc(100dvh - ${FOOTER_H}px)`,
          display: 'grid',
          placeItems: 'center',
          color: 'red',
          fontWeight: 'bold',
        }}
      >
        エラー: {error}
      </div>
    );
  }

  if (!url) {
    return (
      <div
        style={{
          height: `calc(100dvh - ${FOOTER_H}px)`,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        Sofia_AI を開始中…
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: FOOTER_H,
          width: '100vw',
          height: `calc(100vh - ${FOOTER_H}px)`,
          margin: 0,
          padding: 0,
          overflow: 'hidden',
          zIndex: 0,
        }}
      >
        <iframe
          src={url}
          style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
          allow="clipboard-write; microphone; camera"
          onLoad={() => log('📺 iframe loaded:', url)}
        />
      </div>
    </div>
  );
}
