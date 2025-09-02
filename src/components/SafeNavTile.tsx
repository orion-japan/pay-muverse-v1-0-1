'use client';

import Link from 'next/link';
import React from 'react';
import styles from './SafeNavTile.module.css'; // ← モジュールCSS（下に用意）

type Props = {
  allowed: boolean;
  href: string;
  className?: string;
  children: React.ReactNode;
  onBlockedClick?: () => void;
};

export default function SafeNavTile({
  allowed,
  href,
  className = '',
  children,
  onBlockedClick,
}: Props) {
  if (allowed) {
    // 許可時だけ Link を描画（物理的に遷移可能にするのはこのときだけ）
    return (
      <Link href={href} prefetch={false} className={className}>
        {children}
      </Link>
    );
  }

  // 非許可：Link は描画しない。button + style + CSS で完全無効化＆白膜
  return (
    <button
      type="button"
      className={`${className} ${styles.locked}`}
      disabled
      aria-disabled="true"
      tabIndex={-1}
      data-locked="true"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onBlockedClick?.(); }}
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      /* ★ インラインでも強制（CSSが負けても効く） */
      style={{
        pointerEvents: 'none',
        filter: 'grayscale(1) brightness(1.1)',
        opacity: 0.55,
        position: 'relative',
      }}
    >
      {/* 疑似要素が無効な場合の白膜フォールバック */}
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          background: '#fff',
          opacity: 0.35,
          borderRadius: 'inherit',
        }}
      />
      <span style={{ position: 'relative', zIndex: 1 }}>{children}</span>
    </button>
  );
}
