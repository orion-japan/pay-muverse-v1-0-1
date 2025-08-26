'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import '../styles/dashboard.css';
import LoginModal from '../components/LoginModal';
import { useAuth } from '@/context/AuthContext';
import AppModal from '@/components/AppModal';
import { FileContentProvider } from '@/lib/content.file';
import type { HomeContent } from '@/lib/content';

export default function DashboardPage() {
  const [content, setContent] = useState<HomeContent | null>(null);
  const [current, setCurrent] = useState(0);
  const { user } = useAuth();
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const router = useRouter();

  // ★ iros解放可否（master / admin 判定）
  const [isIrosAllowed, setIsIrosAllowed] = useState(false);

  // LIVEモーダル
  const [liveModalOpen, setLiveModalOpen] = useState(false);
  const [liveModalText, setLiveModalText] = useState('');

  // アクセス拒否モーダル
  const [denyOpen, setDenyOpen] = useState(false);

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

    const tryFetch = async (url: string) => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return null;
        return (await res.json()) as any;
      } catch {
        return null;
      }
    };

    (async () => {
      // どれかが生きていれば拾う
      const meta =
        (await tryFetch('/api/get-user-info')) ||
        (await tryFetch('/api/user-info')) ||
        (await tryFetch('/api/resolve-user')) ||
        {};

      // 可能性のあるキーを全部ケアして小文字比較
      const role = String(meta?.role ?? meta?.user_role ?? '').toLowerCase();
      const clickType = String(meta?.click_type ?? meta?.clickType ?? '').toLowerCase();
      const plan = String(meta?.plan ?? meta?.plan_status ?? meta?.planStatus ?? '').toLowerCase();

      const flagAdmin =
        Boolean(meta?.is_admin) || role === 'admin' || clickType === 'admin';
      const flagMaster =
        Boolean(meta?.is_master) ||
        role === 'master' ||
        clickType === 'master' ||
        plan === 'master';

      const allowed = flagAdmin || flagMaster;

      if (!aborted) {
        setIsIrosAllowed(allowed);
        // デバッグしたい時だけ:
        // console.debug('[gate]', { role, clickType, plan, flagAdmin, flagMaster, allowed, meta });
      }
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

  // userCode をURLに付けるページは無し
  const needsUserParam = new Set<string>();

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
    <div
      className="dashboard-wrapper"
      onClick={() => {
        if (!user) setIsLoginModalOpen(true);
      }}
    >
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

            return (
              <div
                key={item.title}
                className={`tile mu-card ${['tile--mu','tile--kyomei','tile--live','tile--plan','tile--create'][idx] ?? ''} ${disabled ? 'disabled' : ''}`}
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
    </div>
  );
}
