// src/app/iros/layout.tsx
import React from 'react';

export default function IrosLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // /iros 配下のページ（/iros, /iros/remember など）は
  // すべてここに children として入ってきます。
  // ここで IrosChat を直接描画せず、children をそのまま返すことで
  // /iros/remember は RememberPage を正しく表示できます。
  return <>{children}</>;
}

