// src/components/HomeButtons.tsx
'use client';

import React, { useCallback } from 'react';
import IrosGuardTile from '@/components/IrosGuardTile';  // ★ 追加

type Props = {
  /** ログインモーダルを開く関数（未指定でも動くフォールバック付き） */
  openLoginModal?: () => void;
};

export default function HomeButtons({ openLoginModal }: Props) {
  // 未指定時でも落ちないフォールバック
  const handleRequireLogin = useCallback(() => {
    if (typeof openLoginModal === 'function') {
      openLoginModal();
    } else {
      alert('ログインが必要です。');
    }
  }, [openLoginModal]);

  return (
    <div className="tiles-wrap">
      {/* ……他のタイルは既存のまま…… */}

      <IrosGuardTile
        href="/iros_ai"
        className="btn"
        onRequireLogin={handleRequireLogin}
        onDenied={(reason) => {
          if (reason === 'forbidden') {
            alert('この機能は master / admin 限定です。');
          }
        }}
      >
        iros_AI
      </IrosGuardTile>
    </div>
  );
}
