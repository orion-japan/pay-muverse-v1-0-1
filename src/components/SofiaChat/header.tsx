// src/components/SofiaChat/header.tsx
'use client';

import Image from 'next/image';
import type { ReactNode } from 'react';

interface HeaderProps {
  agent?: 'mu' | 'iros';            // MU/Iros の指定（省略可）
  isMobile?: boolean;
  onShowSideBar: () => void;
  onCreateNewChat: () => void;
  /** 任意アイコンを直接渡したい場合（渡されたらこちらが優先） */
  icon?: ReactNode;
}

export default function Header({
  agent = 'mu',
  onShowSideBar,
  onCreateNewChat,
  icon,
}: HeaderProps) {
  // タイトルは agent で自動切替
  const title = agent === 'iros' ? 'iros_AI' : 'mu_AI';

  // デフォルトアイコン（画像自体は四角だとしても外側の丸枠で表示）
  const defaultIcon = (
    <Image
      src={agent === 'iros' ? '/ir.png' : '/mu_ai.png'}
      alt={agent === 'iros' ? 'Iros' : 'Mu'}
      width={20}
      height={20}
      style={{ width: 20, height: 20, objectFit: 'contain' }}
    />
  );

  // 丸型バッジの色（agent ごと）
  const badgeBg = agent === 'iros' ? '#6b21a8' : '#0284c7'; // iros=紫系 / mu=青系

  return (
    <header className="sof-header">
      <button className="sof-btn" onClick={onShowSideBar}>メニュー</button>

      {/* 構造は維持。タイトルの左に丸型バッジを追加 */}
      <h1 className="sof-header__title">
        <span
          className="sof-header__icon"
          aria-hidden
          style={{
            marginRight: 8,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            verticalAlign: 'middle',
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: badgeBg,
            color: '#fff',
            boxShadow: '0 1px 2px rgba(0,0,0,.12)',
            overflow: 'hidden',
          }}
        >
          {icon ?? defaultIcon}
        </span>
        {title}
      </h1>

      <button className="sof-btn primary" onClick={onCreateNewChat}>新規</button>
    </header>
  );
}
