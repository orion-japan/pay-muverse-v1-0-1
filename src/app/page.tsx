'use client';

import { useState, useEffect, useRef, KeyboardEvent } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import '../styles/dashboard.css';
import LoginModal from '../components/LoginModal';
import { useAuth } from '@/context/AuthContext';
import AppModal from '../components/AppModal';
import { FileContentProvider } from '@/lib/content.file';
import { getAuth } from 'firebase/auth';

import type { HomeContent } from '@/lib/content';

export default function DashboardPage() {
  // ★ ページ滞在中だけ body にクラス付与
  useEffect(() => {
    document.body.classList.add('mu-dashboard');
    return () => document.body.classList.remove('mu-dashboard');
  }, []);

  /* === 背景Hue：青(200°)〜紫(300°)の範囲だけで往復 ======================
     - 緑域（~120°）に行かないよう Hue を 200↔300 でブレス
     - デフォ：24時間で 1 往復（行って戻る）
     - localStorage.bgHueSpeed 往復速度倍率（例: 720 -> 24分で1往復）
     - prefers-reduced-motion は固定 260°
  ======================================================================== */
  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const minHue = 200; // 青
    const maxHue = 300; // 紫

    const speedMul = (() => {
      try {
        const raw = localStorage.getItem('bgHueSpeed');
        const v = raw ? Number(raw) : 1;
        return Number.isFinite(v) && v > 0 ? v : 1;
      } catch {
        return 1;
      }
    })();

    const DAY_MS = 24 * 60 * 60 * 1000;
    const duration = DAY_MS / speedMul; // 往復にかける時間

    const setHue = (h: number) => {
      document.documentElement.style.setProperty('--bg-h', h.toFixed(2));
    };

    if (reduced) {
      setHue(260);
      return;
    }

    let raf = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const elapsed = (now - start) % duration;     // 0..duration
      const p = elapsed / duration;                  // 0..1
      // 0→0.5: min→max, 0.5→1: max→min の三角波
      const t = p < 0.5 ? p * 2 : (1 - p) * 2;       // 0..1..0
      const hue = minHue + (maxHue - minHue) * t;    // 200..300..200
      setHue(hue);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const [content, setContent] = useState<HomeContent | null>(null);
  const [current, setCurrent] = useState(0);
  const { user } = useAuth();
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  // iros 解放可否（master / admin 判定）: tri-state（null=判定中）
  const [isIrosAllowed, setIsIrosAllowed] = useState<boolean | null>(null);

  // LIVE/拒否モーダル
  const [liveModalOpen, setLiveModalOpen] = useState(false);
  const [liveModalText, setLiveModalText] = useState('');
  const [denyOpen, setDenyOpen] = useState(false);

  // ▼ ログアウト直後だけ自動でログインモーダルを一度開く
  const prevUserRef = useRef<typeof user | null>(null);
  useEffect(() => {
    if (prevUserRef.current && !user && !isLoginModalOpen) setIsLoginModalOpen(true);
    prevUserRef.current = user;
  }, [user, isLoginModalOpen]);

  // コンテンツ取得
  useEffect(() => {
    FileContentProvider.getHomeContent().then(setContent);
  }, []);

  // スライダー自動切替
  useEffect(() => {
    if (!content?.heroImages?.length) return;
    const id = setInterval(() => {
      setCurrent((p) => (p + 1) % content.heroImages.length);
    }, 4000);
    return () => clearInterval(id);
  }, [content]);

  // ★ master/admin 総合判定
  useEffect(() => {
    let aborted = false;

    if (!user) {
      setIsIrosAllowed(null);
      return;
    }

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
      const auth = getAuth();
      const idToken =
        (await auth.currentUser?.getIdToken(true).catch(() => null)) ??
        (await (user as any)?.getIdToken?.(true).catch(() => null)) ??
        null;

      const metaUserInfo = idToken ? await tryPOST('/api/get-user-info', { idToken }) : null;
      const metaGetCompat =
        metaUserInfo ||
        (idToken
          ? await tryGET('/api/get-user-info', { Authorization: `Bearer ${idToken}` })
          : await tryGET('/api/get-user-info'));

      const meta: any = metaUserInfo || metaGetCompat || {};

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
    { title: 'Event', link: '/kyomeikai', img: '/kyoumai.png', alt: 'Event' },
    { title: '配信', link: '/kyomeikai/live', img: '/live.png', alt: '共鳴会LIVE' },
    { title: 'Self', link: '/self', img: '/nikki.png', alt: 'Self' },
    { title: 'Vision', link: '/vision', img: '/ito.png', alt: 'Vision' },
    { title: 'Create', link: '/create', img: '/mu_create.png', alt: 'Create' },
    { title: 'm Tale', link: '/', img: '/m_tale.png', alt: 'm Tale' },
    { title: 'm Shot', link: '/', img: '/shot.png', alt: 'm Shot' }, // ガード対象
    { title: 'iros', link: '/iros', img: '/ir.png', alt: 'iros' },
  ];

  // 共鳴色
  const glowColors: Record<string, string> = {
    '/mu_full': '#8a2be2',
    '/kyomeikai': '#00bfa5',
    '/kyomeikai/live': '#ff9800',
    '/self': '#2196f3',
    '/vision': '#4caf50',
    '/create': '#e91e63',
    '/': '#9c27b0',
    '/iros': '#ff5722',
    '/pay': '#009688',
  };

  // 薄枠用
  const hexToRgba = (hex: string, alpha = 0.22) => {
    const m = hex.replace('#', '');
    const r = parseInt(m.substring(0, 2), 16);
    const g = parseInt(m.substring(2, 4), 16);
    const b = parseInt(m.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  const activateLink = (link: string) => {
    if (!user) {
      setIsLoginModalOpen(true);
      return;
    }
    if (link === '/iros' && isIrosAllowed === false) {
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

  const handleClick = (link: string) => {
    activateLink(link);
  };

  // キーボード操作
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>, link: string, disabled: boolean) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateLink(link);
    }
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

  // ルート("/")のときだけ Vision を選択扱い
  const isHome = pathname === '/';
  const defaultActivePath = '/vision';

  return (
    <div className="dashboard-wrapper">
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
        {menuItems.map((item) => {
          const isIros = item.link === '/iros';
          const disabledByAuth = !user;
          const disabledByRole = isIros && isIrosAllowed === false;
          const disabled = disabledByAuth || disabledByRole;

          const color = glowColors[item.link] ?? '#7b8cff';

          const active = isHome
            ? item.link === defaultActivePath
            : item.link === '/'
              ? pathname === '/'
              : pathname?.startsWith(item.link);

          return (
            <div
              key={item.title}
              className={`tile ${disabled ? 'disabled' : ''}`}
              data-active={active ? 'true' : 'false'}
              style={{ ['--glow' as any]: color, ['--c1' as any]: color, ['--c2' as any]: color }}
              onClick={(e) => {
                e.stopPropagation();
                if (disabled) {
                  if (disabledByAuth) setIsLoginModalOpen(true);
                  else if (disabledByRole) setDenyOpen(true);
                  return;
                }
                handleClick(item.link);
              }}
              onKeyDown={(e) => handleKeyDown(e, item.link, disabled)}
              role="button"
              tabIndex={disabled ? -1 : 0}
              aria-disabled={disabled}
              title={disabledByRole ? 'この機能は master / admin 限定です' : undefined}
            >
              <div
                className="tile-inner"
                style={{ boxShadow: `inset 0 0 0 1px ${hexToRgba(color, 0.18)}` }}
              >
                <div className="tile-icon">
                  <img src={item.img} alt={item.alt} className="tile-icon-img" draggable={false} />
                </div>
                <div className="tile-label">{item.title}</div>
              </div>
            </div>
          );
        })}
      </section>

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
        title="irosAIにはアクセス権限が必要です"
        onClose={() => setDenyOpen(false)}
        primaryText="OK"
      >
        この機能は <b>masterPLAN</b> の方がご利用いただけます。
      </AppModal>
    </div>
  );
}
