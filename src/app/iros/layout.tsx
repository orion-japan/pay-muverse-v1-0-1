// src/app/iros/layout.tsx
'use client';

import React, { useEffect } from 'react';

export default function IrosLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // /iros 配下に入ったときだけ html, body にフラグを立てて
  // グローバルCSS側でスクロール制御できるようにする
  useEffect(() => {
    document.documentElement.setAttribute('data-iros', 'true');
    document.body.setAttribute('data-iros', 'true');

    return () => {
      document.documentElement.removeAttribute('data-iros');
      document.body.removeAttribute('data-iros');
    };
  }, []);

  // children はそのまま返す（/iros, /iros/remember など）
  return <>{children}</>;
}
