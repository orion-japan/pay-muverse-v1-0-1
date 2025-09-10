'use client';

import React from 'react';
import Image from 'next/image';

export type Agent = 'mu' | 'iros' | 'mirra';

export type HeaderProps = {
  agent: Agent;
  isMobile?: boolean;
  onShowSideBar?: () => void;
  onCreateNewChat?: () => void;
  onRefresh?: () => void; // 読み直し（未指定なら location.reload）
  /** 任意：外からアイコン差し替え */
  icon?: React.ReactNode;
};

export default function Header({
  agent = 'mu',
  onShowSideBar,
  onCreateNewChat,
  onRefresh,
  icon,
}: HeaderProps) {
  const title =
    agent === 'iros' ? 'iros_AI' : agent === 'mirra' ? 'mirra_AI' : 'mu_AI';

  const defaultIcon = (
    <Image
      src={
        agent === 'iros'
          ? '/ir.png'
          : agent === 'mirra'
          ? '/mirra.png'
          : '/mu_ai.png'
      }
      alt={agent === 'iros' ? 'Iros' : agent === 'mirra' ? 'Mirra' : 'Mu'}
      width={24}
      height={24}
      className="sof-icon-img"
      style={{ objectFit: 'cover' }}
      priority
    />
  );

  const handleRefresh = () => {
    if (onRefresh) onRefresh();
    else if (typeof window !== 'undefined') window.location.reload();
  };

  return (
    <header className="sof-header" role="banner" aria-label="AI header">
      {/* 左端：メニュー */}
      <div className="sof-left">
        {onShowSideBar && (
          <button
            onClick={onShowSideBar}
            className="sof-btn"
            aria-label="メニューを開く"
            title="メニュー"
          >
            ☰
          </button>
        )}
      </div>

      {/* 中央：アイコン＋タイトル（厳密中央） */}


<style jsx>{`
  .sof-icon-wrap {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;     /* 丸枠 */
    overflow: hidden;       /* はみ出しをカット */
    background: #f3f4f8;
    border: 1px solid #e0e2ee;
  }
  .sof-icon-img {
    width: 100%;
    height: 100%;
    object-fit: cover;      /* 中央にトリミング */
  }
`}</style>
{/* 中央：アイコン＋タイトル */}
<div className="sof-center">
  <span className="sof-icon-wrap">
    {icon ?? (
      <Image
        src={
          agent === 'iros'
            ? '/ir.png'
            : agent === 'mirra'
            ? '/mirra.png'
            : agent === 'mu'
            ? '/mu_ai.png'
            : '/sofia.png'
        }
        alt={
          agent === 'iros'
            ? 'Iros'
            : agent === 'mirra'
            ? 'mirra'
            : agent === 'mu'
            ? 'Mu'
            : 'Sofia'
        }
        width={28}
        height={28}
        className="sof-icon-img"
        priority
      />
    )}
  </span>
  <span className="sof-title">{title}</span>
</div>

      {/* 右端：読み直し＋新規 */}
      <div className="sof-right">
        <button
          onClick={handleRefresh}
          className="sof-btn"
          aria-label="読み直す"
          title="読み直し"
        >
          ⟳
        </button>
        {onCreateNewChat && (
          <button
            onClick={onCreateNewChat}
            className="sof-btn sof-btn-accent"
            aria-label="新規チャット"
            title="新規"
          >
            ＋
          </button>
        )}
      </div>

      {/* ===== CSS（styled-jsx） ===== */}
      <style jsx>{`
        .sof-header {
          /* 左1fr / 中央auto / 右1fr の3カラムで完全中央配置 */
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
        .sof-left {
          justify-self: start;
        }
        .sof-right {
          justify-self: end;
        }

        .sof-center {
          /* 中央を厳密に中央寄せ */
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
          border-radius: 50%; /* ← アイコンを丸く */
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
          transition: transform 0.06s ease, background 0.15s ease,
            box-shadow 0.15s ease;
          box-shadow: 0 1px 0 rgba(0, 0, 0, 0.03);
          user-select: none;
        }
        .sof-btn:active {
          transform: translateY(1px);
        }
        .sof-btn:hover {
          background: #f2f6ff;
        }
        .sof-btn-accent {
          background: #eef5ff;
          border-color: #cfe0ff;
        }
        .sof-btn-accent:hover {
          background: #e6f0ff;
        }

        @media (max-width: 480px) {
          .sof-header {
            height: 42px;
            padding: 4px 6px;
          }
          .sof-title {
            max-width: 54vw;
            font-size: 13px;
          }
          .sof-btn {
            padding: 6px 9px;
            font-size: 13px;



            
          }
        }
      `}</style>
    </header>
  );
}
