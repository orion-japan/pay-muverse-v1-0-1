'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import '../styles/dashboard.css';
import LoginModal from '../components/LoginModal';
import { useAuth } from '@/context/AuthContext';
import AppModal from '@/components/AppModal';
import { FileContentProvider } from '@/lib/content.file';
import { getAuth } from 'firebase/auth';
import FooterNav from '@/components/FooterNav';

import type { HomeContent } from '@/lib/content';

export default function DashboardPage() {
  const [content, setContent] = useState<HomeContent | null>(null);
  const [current, setCurrent] = useState(0);
  const { user } = useAuth();
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  // ★ iros解放可否（master / admin 判定）
  const [isIrosAllowed, setIsIrosAllowed] = useState(false);

  // LIVEモーダル
  const [liveModalOpen, setLiveModalOpen] = useState(false);
  const [liveModalText, setLiveModalText] = useState('');

  // アクセス拒否モーダル
  const [denyOpen, setDenyOpen] = useState(false);

  // ▼ ログアウト直後だけ一度だけ自動でログインモーダルを開く
  const prevUserRef = useRef<typeof user | null>(null);
  useEffect(() => {
    if (prevUserRef.current && !user && !isLoginModalOpen) {
      setIsLoginModalOpen(true);
    }
    prevUserRef.current = user;
  }, [user, isLoginModalOpen]);

  useEffect(() => {
    FileContentProvider.getHomeContent().then(setContent);
  }, []);

  useEffect(() => {
    if (!content?.heroImages?.length) return;
    const interval = setInterval(() => {
      setCurrent((p) => (p + 1) % content.heroImages.length);
    }, 4000);
    return () => clearInterval(interval);
  }, [content]);

  // ★ ユーザー情報を多系統から取得して master/admin を総合判定
  useEffect(() => {
    let aborted = false;

    if (!user) {
      setIsIrosAllowed(false);
      return;
    }

    // fetch helpers（error時は null）
    const tryPOST = async (url: string, body: any) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    };

    const tryGET = async (url: string, headers?: Record<string, string>) => {
      try {
        const res = await fetch(url, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers,
        } as RequestInit);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    };

    (async () => {
      // 🔑 Firebase ID トークン（確実に取得）
      const auth = getAuth();
      const idToken =
        (await auth.currentUser?.getIdToken(true).catch(() => null)) ??
        (await (user as any)?.getIdToken?.(true).catch(() => null)) ??
        null;

      // ✅ 正攻法：POST で idToken を渡す（これだけで十分）
      const metaUserInfo =
        idToken ? await tryPOST('/api/get-user-info', { idToken }) : null;

      // 予備（不要なら消してOK）：GET で Authorization or ?idToken=
      const metaGetCompat =
        metaUserInfo ||
        (idToken
          ? await tryGET('/api/get-user-info', {
              Authorization: `Bearer ${idToken}`,
            })
          : await tryGET('/api/get-user-info')); // ← 本当に最後のフォールバック

      const meta: any = metaUserInfo || metaGetCompat || {};

      // --- 権限判定 ---
      const role = String(meta.role ?? meta.user_role ?? '').toLowerCase();
      const clickType = String(meta.click_type ?? meta.clickType ?? '').toLowerCase();
      const plan = String(meta.plan ?? meta.plan_status ?? meta.planStatus ?? '').toLowerCase();

      const truthy = (v: any) => v === true || v === 1 || v === '1' || v === 'true';

      const flagAdmin =
        truthy(meta.is_admin) || role === 'admin' || clickType === 'admin' || plan === 'admin';

      const flagMaster =
        truthy(meta.is_master) || role === 'master' || clickType === 'master' || plan === 'master';

      const allowed = flagAdmin || flagMaster;

      if (!aborted) setIsIrosAllowed(allowed);
    })();

    return () => {
      aborted = true;
    };
  }, [user]);

  // メニュー
  const menuItems: { title: string; link: string; img: string; alt: string }[] = [
    { title: 'Mu_AI', link: '/mu_full', img: '/mu_ai.png', alt: 'Mu_AI' },
    { title: '共鳴会', link: '/kyomeikai', img: '/kyoumai.png', alt: '共鳴会' },
    { title: '配信', link: '/kyomeikai/live', img: '/live.png', alt: '共鳴会LIVE' },
    { title: 'Self', link: '/self', img: '/nikki.png', alt: 'Self' },
    { title: 'Vision', link: '/vision', img: '/ito.png', alt: 'Vision' },
    { title: 'Create', link: '/create', img: '/mu_create.png', alt: 'Create' },
    { title: 'm Tale', link: '/', img: '/m_tale.png', alt: 'm Tale' },
    { title: 'iros', link: '/iros', img: '/ir.png', alt: 'iros' }, // ← ここをガード
    { title: 'プラン', link: '/pay', img: '/mu_card.png', alt: 'プラン' },
  ];

  // 共鳴色（リンク毎）
  const glowColors: Record<string, string> = {
    '/mu_full': '#8a2be2',        // 紫
    '/kyomeikai': '#00bfa5',      // ティール
    '/kyomeikai/live': '#ff9800', // オレンジ
    '/self': '#2196f3',           // ブルー
    '/vision': '#4caf50',         // グリーン
    '/create': '#e91e63',         // ピンク
    '/': '#9c27b0',               // トップ
    '/iros': '#ff5722',           // ディープオレンジ
    '/pay': '#009688',            // エメラルド
  };

  const handleClick = (link: string) => {
    if (!user) {
      setIsLoginModalOpen(true);
      return;
    }
    // ★ iros ガード（master / admin のみ通す）
    if (link === '/iros' && !isIrosAllowed) {
      setDenyOpen(true);
      return;
    }

    if (link === '/mu_full') {
      router.push('/mu_full');
      return;
    }
    if (link === '/kyomeikai/live') {
      checkLiveAndGo(link);
      return;
    }
    router.push(link);
  };

  const checkLiveAndGo = async (link: string) => {
    try {
      const r = await fetch('/api/kyomeikai/live/status', { cache: 'no-store' });
      const j = await r.json();
      if (!j?.is_live) {
        setLiveModalText('現在LIVE配信は行われていません。開始までお待ちください。');
        setLiveModalOpen(true);
        return;
      }
      const url = j?.room ? `${link}?room=${encodeURIComponent(j.room)}` : link;
      router.push(url);
    } catch {
      setLiveModalText('配信状況を確認できませんでした。時間をおいて再度お試しください。');
      setLiveModalOpen(true);
    }
  };

  const images = content?.heroImages ?? [];
  const notices = content?.notices ?? [];

  return (
    <div className="dashboard-wrapper">
      <div style={{ paddingTop: '2.5px' }}>
        {/* スライダー */}
        <section className="slider-container">
          {images.map((img, index) => (
            <img
              key={img}
              src={img}
              alt={`Muverse Banner ${index}`}
              className={`slider-image ${index === current ? 'active' : ''}`}
              draggable={false}
            />
          ))}
        </section>

        {/* お知らせ */}
        <section className="notice-section">
          <h2 className="notice-title">📢 お知らせ</h2>
          {notices.map((n) => (
            <div key={n.id} className="notice-item">
              {n.text}
            </div>
          ))}
        </section>

        {/* タイルメニュー */}
        <section className="tile-grid">
          {menuItems.map((item, idx) => {
            const isIros = item.link === '/iros';
            const disabledByAuth = !user;
            const disabledByRole = isIros && !isIrosAllowed;
            const disabled = disabledByAuth || disabledByRole;

            // 共鳴色
            const color = glowColors[item.link] ?? '#7b8cff';

            // 現在ページ（選択）判定
            const active =
              item.link === '/'
                ? pathname === '/'
                : pathname?.startsWith(item.link);

            return (
              <div
                key={item.title}
                className={`tile mu-card ${disabled ? 'disabled' : ''}`}
                data-active={active ? 'true' : 'false'}
                style={{ ['--glow' as any]: color }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (disabled) {
                    if (disabledByAuth) setIsLoginModalOpen(true);
                    else if (disabledByRole) setDenyOpen(true);
                    return;
                  }
                  handleClick(item.link);
                }}
                aria-disabled={disabled}
                title={disabledByRole ? 'この機能は master / admin 限定です' : undefined}
              >
                <div className="tile-inner">
                  <div className="tile-icon">
                    <img src={item.img} alt={item.alt} className="tile-icon-img" draggable={false} />
                  </div>
                  <div className="tile-label">{item.title}</div>
                </div>
              </div>
            );
          })}
        </section>
      </div>

      {/* ログインモーダル */}
      <LoginModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onLoginSuccess={() => setIsLoginModalOpen(false)}
      />

      {/* LIVE用モーダル */}
      <AppModal
        open={liveModalOpen}
        title="共鳴会 LIVE"
        onClose={() => setLiveModalOpen(false)}
        primaryText="OK"
      >
        {liveModalText}
      </AppModal>

      {/* アクセス拒否モーダル */}
      <AppModal
        open={denyOpen}
        title="アクセス権限が必要です"
        onClose={() => setDenyOpen(false)}
        primaryText="OK"
      >
        この機能は <b>master / admin</b> のみご利用いただけます。
      </AppModal>

      {/* ★ フッター（未ログイン時はHome以外→ログインモーダル） */}
      <FooterNav
        isLoggedIn={!!user}
        onRequireLogin={() => setIsLoginModalOpen(true)}
      />
    </div>
  );
}
