'use client';

import { useState, useEffect, useRef, KeyboardEvent } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import '../../styles/dashboard.css';
import LoginModal from '../../components/LoginModal';
import { useAuth } from '@/context/AuthContext';
import AppModal from '../../components/AppModal';
import { FileContentProvider } from '@/lib/content.file';
import { getAuth } from 'firebase/auth';

import type { HomeContent } from '@/lib/content';

export default function DashboardPage() {
  // ★ ページ滞在中だけ body にクラス付与
  useEffect(() => {
    document.body.classList.add('mu-dashboard');
    return () => document.body.classList.remove('mu-dashboard');
  }, []);

  /* === 背景Hue：青(200°)〜紫(300°)の範囲だけで往復 ====================== */
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
      const elapsed = (now - start) % duration; // 0..duration
      const p = elapsed / duration; // 0..1
      // 0→0.5: min→max, 0.5→1: max→min の三角波
      const t = p < 0.5 ? p * 2 : (1 - p) * 2; // 0..1..0
      const hue = minHue + (maxHue - minHue) * t; // 200..300..200
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

  // ★ 追加：リロード直後 3 秒ロック（iros専用）
  const [irosReloadLock, setIrosReloadLock] = useState<boolean>(false);
  useEffect(() => {
    let isReload = false;
    try {
      const nav = (
        performance.getEntriesByType?.('navigation') as PerformanceNavigationTiming[]
      )?.[0];
      isReload = nav?.type === 'reload';
      // 旧APIフォールバック
      // @ts-ignore
      if (!isReload && performance.navigation?.type === 1) isReload = true;
    } catch {}
    if (isReload) {
      setIrosReloadLock(true);
      const t = setTimeout(() => setIrosReloadLock(false), 3000); // ← 3秒
      return () => clearTimeout(t);
    }
  }, []);

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

  // ★ master/admin 総合判定（401対策：常にBearer送信 + 401時リトライ）
  useEffect(() => {
    let aborted = false;

    if (!user) {
      setIsIrosAllowed(null);
      return;
    }

    const getFreshIdToken = async () => {
      try {
        const auth = getAuth();
        // 強制リフレッシュで常に新鮮なトークンを取得
        const tok =
          (await auth.currentUser?.getIdToken(true).catch(() => null)) ??
          (await (user as any)?.getIdToken?.(true).catch(() => null)) ??
          null;
        return tok;
      } catch {
        return null;
      }
    };

    const fetchUserMeta = async (idToken: string) => {
      const res = await fetch('/api/get-user-info', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (res.status === 401) throw new Error('unauthorized');
      if (!res.ok) throw new Error('fetch-error');
      return res.json();
    };

    (async () => {
      try {
        let idToken = await getFreshIdToken();
        if (!idToken) throw new Error('no-token');

        let meta: any;
        try {
          meta = await fetchUserMeta(idToken);
        } catch (e: any) {
          // 401などは一度だけトークン再取得して再試行
          if (e?.message === 'unauthorized') {
            idToken = await getFreshIdToken();
            if (!idToken) throw new Error('no-token-2');
            meta = await fetchUserMeta(idToken);
          } else {
            throw e;
          }
        }

        if (aborted) return;

        const role = String(meta.role ?? meta.user_role ?? '').toLowerCase();
        const clickType = String(meta.click_type ?? meta.clickType ?? '').toLowerCase();
        const plan = String(meta.plan ?? meta.plan_status ?? meta.planStatus ?? '').toLowerCase();

        const truthy = (v: any) => v === true || v === 1 || v === '1' || v === 'true';

        const flagAdmin =
          truthy(meta.is_admin) || role === 'admin' || clickType === 'admin' || plan === 'admin';
        const flagMaster =
          truthy(meta.is_master) ||
          role === 'master' ||
          clickType === 'master' ||
          plan === 'master';

        const allowed = flagAdmin || flagMaster;
        setIsIrosAllowed(allowed);
      } catch {
        if (!aborted) setIsIrosAllowed(false); // 取得失敗時は閉じておく
      }
    })();

    return () => {
      aborted = true;
    };
  }, [user]);

  // メニュー
  const menuItems: { title: string; link: string; img: string; alt: string }[] = [
    { title: 'Mu_AI', link: '/chat', img: '/mu_ai.png', alt: 'Mu_AI' },
    { title: 'Event', link: '/event', img: '/kyoumai.png', alt: 'Event' },
    { title: 'Lecture', link: '/lecture', img: '/lecture.png', alt: 'Lecture' },
    { title: 'Self', link: '/self', img: '/nikki.png', alt: 'Self' },
    { title: 'R Vision', link: '/vision', img: '/ito.png', alt: 'R Vision' },
    { title: 'Create', link: '/create', img: '/mu_create.png', alt: 'Create' },
    { title: 'm Talk', link: '/mtalk', img: '/mirra.png', alt: 'm Talk' },
    { title: 'F Shot', link: '/', img: '/mui.png', alt: 'F Shot' }, // ガード対象
    { title: 'iros_AI', link: '/sofia', img: '/ir2.png', alt: 'iros_AI' },
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
    // ★ iros は 3秒ロック or 権限NG のときは遷移させない
    if (link === '/iros') {
      if (irosReloadLock) {
        // ロック中の案内（必要ならトースト等に変更）
        setLiveModalText(
          'リロード直後は 3 秒間、iros_AI は利用できません。しばらくお待ちください。',
        );
        setLiveModalOpen(true);
        return;
      }
      if (isIrosAllowed === false) {
        setDenyOpen(true);
        return;
      }
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

  // 🔐 秘密ボタンクリック時の処理（パスワード 123456）
  const handleSecretClick = () => {
    const pw = window.prompt('開発用エリアのパスワードを入力してください');
    if (pw === null) return; // キャンセル
    if (pw === '123456') {
      router.push('/secret-tools'); // ← 秘密メニュー用ページ（お好みのパスに変更OK）
    } else {
      alert('パスワードが違います');
    }
  };

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
          // ★ 追加：リロード直後3秒ロック（iros のみ）
          const disabledByReload = isIros && irosReloadLock;

          const disabled = disabledByAuth || disabledByRole || disabledByReload;

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
                  else if (disabledByReload) {
                    setLiveModalText(
                      'リロード直後は 3 秒間、iros_AI は利用できません。しばらくお待ちください。',
                    );
                    setLiveModalOpen(true);
                  } else if (disabledByRole) setDenyOpen(true);
                  return;
                }
                handleClick(item.link);
              }}
              onKeyDown={(e) => handleKeyDown(e, item.link, disabled)}
              role="button"
              tabIndex={disabled ? -1 : 0}
              aria-disabled={disabled}
              title={
                disabledByReload
                  ? 'リロード直後は 3 秒間は利用できません'
                  : disabledByRole
                    ? 'この機能は master / admin 限定です'
                    : undefined
              }
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

      {/* 🔐 秘密ボタン（ページの一番下） */}
      <section
        style={{
          margin: '12px 0 24px',
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <button
          type="button"
          onClick={handleSecretClick}
          style={{
            padding: '8px 18px',
            borderRadius: 999,
            border: 'none',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            background:
              'linear-gradient(90deg, #7f9bff 0%, #ff90c9 50%, #ffd56b 100%)',
            color: '#fff',
            boxShadow: '0 4px 14px rgba(120,140,255,0.45)',
            opacity: 0.85,
          }}
        >
          🔐 Secret Lab
        </button>
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
