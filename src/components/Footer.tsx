'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';

const FALLBACK_H = 56;

type ItemId = 'iros' | 'event' | 'mypage' | 'plan' | 'setting';

type Item = {
  id: ItemId;
  label: string;
  href: string;
  icon?: React.ReactNode;
};

function detectKeyboardOpen(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;

  const vv = window.visualViewport;
  const heightGap = vv ? window.innerHeight - vv.height : 0;

  const active = document.activeElement as HTMLElement | null;
  const tag = active?.tagName?.toLowerCase() ?? '';
  const isEditable =
    tag === 'textarea' ||
    (tag === 'input' && !['button', 'checkbox', 'radio', 'range', 'file', 'submit'].includes((active as HTMLInputElement).type || '')) ||
    Boolean(active?.isContentEditable);

  const ua = navigator.userAgent || '';
  const isIOS =
    /iPhone|iPad|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (heightGap > 120) return true;

  if (isIOS && isEditable) return true;

  return false;
}

export default function Footer() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);

  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    let el = document.getElementById('mu-footer-root') as HTMLDivElement | null;
    if (!el) {
      el = document.createElement('div');
      el.id = 'mu-footer-root';
      document.body.appendChild(el);
    }
    setHost(el);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const vv = window.visualViewport;
    if (!vv) return;

    let raf = 0;

    const syncKeyboardState = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setKeyboardOpen(detectKeyboardOpen());
      });
    };

    vv.addEventListener('resize', syncKeyboardState);
    vv.addEventListener('scroll', syncKeyboardState);
    window.addEventListener('resize', syncKeyboardState);

    syncKeyboardState();

    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener('resize', syncKeyboardState);
      vv.removeEventListener('scroll', syncKeyboardState);
      window.removeEventListener('resize', syncKeyboardState);
    };
  }, []);

  useEffect(() => {
    const setPad = (h: number) => {
      const px = Math.max(0, Math.round(h || 0));
      const footerBottomGap = 12;
      document.documentElement.style.setProperty(
        '--footer-h',
        `${px + footerBottomGap}px`,
      );
      document.documentElement.style.setProperty(
        '--footer-safe-pad',
        `calc(${px + footerBottomGap}px + env(safe-area-inset-bottom))`,
      );
    };

    if (keyboardOpen) {
      setPad(0);
      return;
    }

    setPad(FALLBACK_H);

    const el = navRef.current;
    if (!el) return;

    const update = () => {
      if (keyboardOpen) {
        setPad(0);
        return;
      }
      setPad(el.getBoundingClientRect().height);
    };

    update();

    const ro = new ResizeObserver(update);
    ro.observe(el);

    return () => ro.disconnect();
  }, [host, mounted, keyboardOpen]);

  const items: Item[] = useMemo(
    () => [
      { id: 'iros', label: 'Iros', href: '/', icon: <span>🌀</span> },
      { id: 'event', label: 'Event', href: '/event', icon: <span>🎉</span> },
      { id: 'mypage', label: 'My Page', href: '/mypage', icon: <span>👤</span> },
      { id: 'plan', label: 'Plan', href: '/pay', icon: <span>💳</span> },
      {
        id: 'setting',
        label: 'Setting',
        href: '/iros-ai/settings',
        icon: <span>⚙️</span>,
      },
    ],
    [],
  );

  const onClick = (it: Item) => (e: React.MouseEvent) => {
    e.preventDefault();
    if (pathname !== it.href) router.push(it.href);
  };

  if (!mounted || keyboardOpen) return null;

  const Nav = (
    <nav
      ref={navRef}
      style={{
        position: 'fixed',
        left: '50%',
        bottom: '12px',
        transform: 'translateX(-50%)',
        width: 'calc(100% - 24px)',
        maxWidth: 560,
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 12,
        background: '#fff',
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
        zIndex: 1000,
        paddingBottom: 'max(6px, env(safe-area-inset-bottom))',
        borderTop: '1px solid #e5e7eb',
      }}
    >
      {items.map((it) => {
        const active = pathname === it.href;

        return (
          <a
            key={it.id}
            href={it.href}
            onClick={onClick(it)}
            style={{
              display: 'grid',
              placeItems: 'center',
              gap: 2,
              textDecoration: 'none',
              borderRadius: 12,
              padding: '4px 2px',
              color: active ? '#4b5cff' : '#333',
            }}
          >
            <div style={{ fontSize: 16 }}>{it.icon}</div>
            <div style={{ fontSize: 11, fontWeight: 600 }}>{it.label}</div>
          </a>
        );
      })}
    </nav>
  );

  return host ? createPortal(Nav, host) : Nav;
}
