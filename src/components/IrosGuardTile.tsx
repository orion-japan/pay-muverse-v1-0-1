'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { fetchWithIdToken } from '@/lib/fetchWithIdToken';
import styles from './IrosGuardTile.module.css';

type Props = {
  href: string; // 許可OK時の遷移先（例: '/iros_ai'）
  className?: string;
  children: React.ReactNode;
  onRequireLogin?: () => void; // 未ログイン時の誘導
  onDenied?: (reason?: string) => void; // 権限NG/エラー時の通知
};

export default function IrosGuardTile({
  href,
  className = '',
  children,
  onRequireLogin,
  onDenied,
}: Props) {
  const router = useRouter();

  const [pending, setPending] = React.useState(false);
  const [unlocked, setUnlocked] = React.useState(false); // 許可判定後だけ解除
  const [reloadLock, setReloadLock] = React.useState(false); // リロード直後3秒ロック

  // 「リロード直後だけ3秒ロック」
  React.useEffect(() => {
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
      setReloadLock(true);
      const t = setTimeout(() => setReloadLock(false), 3000);
      return () => clearTimeout(t);
    }
  }, []);

  const handleCheck = async () => {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetchWithIdToken('/api/guard/iros', { method: 'GET' });
      if (res.status === 401) {
        onRequireLogin?.();
        return;
      }
      if (!res.ok) {
        onDenied?.('network_error');
        return;
      }
      const data: { allowed: boolean } = await res.json();
      if (data.allowed) {
        setUnlocked(true);
        requestAnimationFrame(() => router.push(href));
      } else {
        onDenied?.('forbidden');
      }
    } catch {
      onDenied?.('error');
    } finally {
      setPending(false);
    }
  };

  // 見た目は常に button。基本は disabled（unlocked 時のみ実ボタンも押下可）
  const isBlocked = reloadLock || !unlocked;

  return (
    <div className={`${styles.wrap} ${className}`} data-guard-lock={isBlocked ? '1' : undefined}>
      <button
        type="button"
        className={`${styles.tile} ${isBlocked ? styles.locked : ''}`}
        disabled={isBlocked || pending}
        aria-disabled={isBlocked || pending}
        tabIndex={isBlocked ? -1 : 0}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!isBlocked) router.push(href); // unlocked 済みの保険
        }}
      >
        {children}
      </button>

      {/* 透明オーバーレイ：押下イベントは必ずここが拾う */}
      <div
        className={styles.blocker}
        aria-hidden="true"
        onClickCapture={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (reloadLock) return; // 3秒ロック中は何もしない
          if (!unlocked) handleCheck(); // ロック明けはサーバ認証→OKなら遷移
        }}
        onPointerDownCapture={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onTouchStartCapture={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onMouseDownCapture={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onKeyDownCapture={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            if (!reloadLock && !unlocked) handleCheck();
          }
        }}
      />
    </div>
  );
}
