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

  // 追加: プラン/ロール取得（master/admin 判定用）
  const [planStatus, setPlanStatus] = useState<string | null>(null);

  // LIVEモーダル
  const [liveModalOpen, setLiveModalOpen] = useState(false);
  const [liveModalText, setLiveModalText] = useState('');

  // 追加: アクセス拒否モーダル
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

  // 追加: user ログイン時に plan_status を取得
  useEffect(() => {
    let aborted = false;
    if (!user) {
      setPlanStatus(null);
      return;
    }
    (async () => {
      try {
        const res = await fetch('/api/get-user-info', { cache: 'no-store' });
        const j = await res.json().catch(() => ({} as any));
        if (!aborted) {
          // API のキー名ゆらぎ対策
          const ps = j?.plan_status ?? j?.planStatus ?? null;
          setPlanStatus(ps);
        }
      } catch {
        if (!aborted) setPlanStatus(null);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [user]);

  const canAccessIros = planStatus === 'master' || planStatus === 'admin';

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
    // 追加: iros ガード
    if (link === '/iros' && !canAccessIros) {
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
            const disabledByRole = isIros && !canAccessIros;
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

      {/* 追加: アクセス拒否モーダル */}
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
