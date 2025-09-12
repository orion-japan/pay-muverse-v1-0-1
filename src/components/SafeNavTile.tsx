'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import styles from './SafeNavTile.module.css';

type Props = {
  allowed: boolean;            // 認証後 master/admin なら true
  href: string;
  className?: string;
  children: React.ReactNode;
  onBlockedClick?: () => void; // 未ログイン時の誘導など
};

export default function SafeNavTile({
  allowed,
  href,
  className = '',
  children,
  onBlockedClick,
}: Props) {
  const router = useRouter();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const canNavigate = mounted && allowed;
  const isLocked = !canNavigate;

  return (
    <div
      className={`${styles.wrap} ${className}`}
      data-guard-lock={isLocked ? '1' : undefined}   // ★ ガード印
    >
      <button
        type="button"
        className={`${styles.tile} ${isLocked ? styles.locked : ''}`}
        disabled={isLocked}
        aria-disabled={isLocked}
        tabIndex={isLocked ? -1 : 0}
        draggable={false}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isLocked) { onBlockedClick?.(); return; }
          router.push(href);
        }}
      >
        {children}
      </button>
    </div>
  );
}
