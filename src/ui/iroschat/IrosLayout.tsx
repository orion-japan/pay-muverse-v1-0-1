// src/ui/iroschat/IrosLayout.tsx
'use client';

import React from 'react';
import styles from './index.module.css';

/**
 * NOTE:
 * - IrosChatShell が Header / Sidebar / MessageList / ChatInput を持っています。
 * - ここでは余計な UI を持たず、レイアウトの器だけにします。
 * - これで二重描画と CSS 競合を防ぎます。
 */
export default function IrosLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.root}>
      <main className={styles.content} aria-label="Iros content">
        {children}
      </main>
    </div>
  );
}
