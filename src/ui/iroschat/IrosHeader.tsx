// src/ui/iroschat/IrosHeader.tsx
'use client';

import React from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';

// ★ 追加：チャットコンテキスト & メタバッジ
import { useIrosChat } from './IrosChatContext';
import IrosMetaBadge from './components/IrosMetaBadge';

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

  // ★ 追加：IrosChatContext から最新メタ情報を取得（型は any で柔らかく）
  const chatCtx = (typeof useIrosChat === 'function' ? useIrosChat() : null) as any;

  // 可能性のあるキーを順番に探す（実装差異に強くするため）
  const currentMeta =
    chatCtx?.currentMeta ??
    chatCtx?.lastMeta ??
    chatCtx?.meta ??
    null;

  const qCode =
    currentMeta?.qCode ??
    currentMeta?.q_code ??
    undefined;

  const depth =
    currentMeta?.depth ??
    currentMeta?.depth_stage ??
    null;

  const mode = currentMeta?.mode ?? null;

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
    e?.stopPropagation();
    if (onRefresh) onRefresh();
    else if (typeof window !== 'undefined') window.location.reload();
  };

  const handleMenu = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    onShowSideBar?.();
  };

  const handleNewChat = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();

    try {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem('iros_chat_draft');
      }
    } catch {}

    if (onCreateNewChat) {
      onCreateNewChat();
    } else {
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
        {/* ★ 追加：右上の Q / 深度 / モード インジケーター（compact 表示） */}
        {currentMeta && (
          <div className="sof-meta-wrap" aria-label="Iros meta indicator">
            <IrosMetaBadge
              qCode={qCode}
              depth={depth}
              mode={mode}
              compact
            />
          </div>
        )}

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

        /* ★ インジケーター用の軽い余白調整 */
        .sof-meta-wrap {
          display: flex;
          align-items: center;
          margin-right: 4px;
        }

        @media (max-width: 480px) {
          .sof-header { height: 42px; padding: 4px 6px; }
          .sof-title { max-width: 54vw; font-size: 13px; }
          .sof-btn { padding: 6px 9px; font-size: 13px; }
        }
      `}</style>
    </header>
  );
}
