'use client';

import './mypage.css';
import { useEffect } from 'react';

// テーマ反映（必要ならそのまま維持）
const setTheme = (theme: 'light' | 'dark') => {
  const html = document.documentElement;
  html.classList.remove('light', 'dark');
  html.classList.add(theme);
  localStorage.setItem('theme', theme);
};
const getInitialTheme = (): 'light' | 'dark' => {
  if (typeof window === 'undefined') return 'light';
  return (localStorage.getItem('theme') as 'light' | 'dark') || 'light';
};

export default function MyPageLayout({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const theme = getInitialTheme();
    setTheme(theme);
  }, []);

  // ここでは “背景だけ” を持つ。影/角丸は付けない
  return <div className="mypage-wrapper">{children}</div>;
}
