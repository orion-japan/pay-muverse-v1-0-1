import React from 'react';
import Image from 'next/image';

export type Agent = 'mu' | 'iros' | 'mirra';

export type HeaderProps = {
  agent: Agent;
  isMobile?: boolean;
  onShowSideBar?: () => void;
  onCreateNewChat?: () => void;
  /** 任意：外からアイコン差し替え */
  icon?: React.ReactNode;
};

export default function Header({
  agent = 'mu',
  onShowSideBar,
  onCreateNewChat,
  icon,
}: HeaderProps) {
  // タイトルは agent で自動切替
  const title =
    agent === 'iros' ? 'iros_AI' : agent === 'mirra' ? 'mirra_AI' : 'mu_AI';

  // デフォルトアイコン
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
      width={20}
      height={20}
      style={{ width: 20, height: 20, objectFit: 'contain' }}
    />
  );

  return (
    <header className="sof-header">
      <div className="sof-header-left">
        {icon ?? defaultIcon}
        <span className="sof-title">{title}</span>
      </div>
      <div className="sof-header-right">
        {onShowSideBar && (
          <button onClick={onShowSideBar} className="sof-btn">☰</button>
        )}
        {onCreateNewChat && (
          <button onClick={onCreateNewChat} className="sof-btn">＋</button>
        )}
      </div>
    </header>
  );
}
