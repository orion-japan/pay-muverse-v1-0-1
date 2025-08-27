'use client';

import { useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import styles from './footer-nav.module.css';

type Item = { label: string; href: string; icon?: React.ReactNode };

export default function FooterNav({
  isLoggedIn,
  onRequireLogin,
}: {
  isLoggedIn: boolean;
  onRequireLogin: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const items: Item[] = useMemo(
    () => [
      { label: 'Home',   href: '/',       icon: <span>🏠</span> },
      { label: 'Talk',   href: '/talk',   icon: <span>💬</span> },
      { label: 'I Board',href: '/board',  icon: <span>🧩</span> },
      { label: 'My Page',href: '/mypage', icon: <span>👤</span> },
    ],
    []
  );

  const handleClick = (it: Item) => (e: React.MouseEvent) => {
    const isHome = it.href === '/';
    const disabled = !isLoggedIn && !isHome;

    e.preventDefault();
    if (disabled) {
      onRequireLogin();
      return;
    }
    router.push(it.href);
  };

  return (
    <nav className={styles.footerNav} aria-label="Primary">
      {items.map((it) => {
        const active = pathname === it.href || (it.href !== '/' && pathname?.startsWith(it.href));
        const isHome = it.href === '/';
        const disabled = !isLoggedIn && !isHome;

        return (
          <a
            key={it.href}
            href={it.href}
            onClick={handleClick(it)}
            className={`${styles.item} ${active ? styles.active : ''} ${disabled ? styles.disabled : ''}`}
            aria-current={active ? 'page' : undefined}
            aria-disabled={disabled || undefined}
            role="button"
          >
            <div className={styles.icon}>{it.icon}</div>
            <div className={styles.label}>{it.label}</div>
            {active && <span className={styles.pill} aria-hidden />}
          </a>
        );
      })}
    </nav>
  );
}
