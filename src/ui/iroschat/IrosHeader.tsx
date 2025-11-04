// src/ui/iroschat/IrosHeader.tsx
'use client';

import React from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';

export type HeaderProps = {
  onShowSideBar?: () => void;
  onCreateNewChat?: () => void;
  onRefresh?: () => void;
  icon?: React.ReactNode;
};

export default function IrosHeader({
  onShowSideBar,
  onCreateNewChat,
  onRefresh,
  icon,
}: HeaderProps) {
  const router = useRouter();
  const title = 'iros_AI';

  const defaultIcon = (
    <Image
      src="/ir.png"
      alt="Iros"
      width={28}
      height={28}
      className="sof-icon-img"
      priority
      style={{ objectFit: 'cover' }}
    />
  );

  const handleRefresh = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation(); // ← 親に伝播させない
    if (onRefresh) onRefresh();
    else if (typeof window !== 'undefined') window.location.reload();
  };

  const handleMenu = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation(); // ← これが無いと他のハンドラが動く場合あり
    onShowSideBar?.();
  };

  const handleNewChat = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation(); // ← サイドバー開閉への伝播を遮断

    // draft は先に消す
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem('iros_chat_draft');
      }
    } catch {}

    if (onCreateNewChat) {
      // 例: selectConversation('new') を内部で実行
      onCreateNewChat();
    } else {
      // フォールバック（配線が無い場合）
      router.replace('/iros?cid=new&agent=iros', { scroll: false });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('iros:new-chat'));
      }
    }
  };

  return (
    <header className="sof-header" role="banner" aria-label="AI header">
      <div className="sof-left">
        {onShowSideBar && (
          <button
            type="button"
            onClick={handleMenu}
            className="sof-btn"
            aria-label="メニューを開く"
            title="メニュー"
          >
            ☰
          </button>
        )}
      </div>

      <div className="sof-center">
        <span className="sof-icon-wrap">{icon ?? defaultIcon}</span>
        <span className="sof-title">{title}</span>
      </div>

      <div className="sof-right">
        <button
          type="button"
          onClick={handleRefresh}
          className="sof-btn"
          aria-label="読み直す"
          title="読み直し"
        >
          ⟳
        </button>
        <button
          type="button"
          onClick={handleNewChat}
          className="sof-btn sof-btn-accent"
          aria-label="新規チャット"
          title="新規"
        >
          ＋
        </button>
      </div>

      <style jsx>{`
        .sof-header {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
          align-items: center;
          gap: 8px;
          width: 100%;
          height: 44px;
          padding: 4px 8px;
          border-bottom: 1px solid #e6e6ee;
          background: #ffffff;
          position: sticky;
          top: 0;
          z-index: 10;
        }
        .sof-left,
        .sof-right {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .sof-left { justify-self: start; }
        .sof-right { justify-self: end; }
        .sof-center {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          justify-self: center;
          min-width: 0;
        }
        .sof-title {
          font-weight: 700;
          font-size: 14px;
          line-height: 1;
          white-space: nowrap;
          text-overflow: ellipsis;
          overflow: hidden;
          max-width: 60vw;
        }
        .sof-icon-wrap {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          border-radius: 50%;
          background: #f3f4f8;
          border: 1px solid #e0e2ee;
          box-shadow: 0 1px 0 rgba(0, 0, 0, 0.02) inset;
        }
        .sof-icon-img {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          display: block;
        }
        .sof-btn {
          appearance: none;
          border: 1px solid #e0e2ee;
          background: #fafbff;
          border-radius: 10px;
          padding: 6px 10px;
          line-height: 1;
          font-size: 14px;
          cursor: pointer;
          transition: transform 0.06s ease, background 0.15s ease, box-shadow 0.15s ease;
          box-shadow: 0 1px 0 rgba(0, 0, 0, 0.03);
          user-select: none;
        }
        .sof-btn:active { transform: translateY(1px); }
        .sof-btn:hover { background: #f2f6ff; }
        .sof-btn-accent { background: #eef5ff; border-color: #cfe0ff; }
        .sof-btn-accent:hover { background: #e6f0ff; }
        @media (max-width: 480px) {
          .sof-header { height: 42px; padding: 4px 6px; }
          .sof-title { max-width: 54vw; font-size: 13px; }
          .sof-btn { padding: 6px 9px; font-size: 13px; }
        }
      `}</style>
    </header>
  );
}
