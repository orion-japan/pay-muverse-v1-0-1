'use client';

import React from 'react';
import '../board/board.css'; // boardページ専用スタイル

export default function BoardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className="board-layout"
      style={{
        width: '100%',
        overflowX: 'visible',
        padding: 0,
        margin: 0,
      }}
    >
      {children}
    </div>
  );
}
