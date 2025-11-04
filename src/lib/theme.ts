// src/lib/theme.ts
export const setTheme = (theme: 'light' | 'dark') => {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;

  html.classList.remove('light', 'dark');
  html.classList.add(theme);

  // 永続保存
  localStorage.setItem('theme', theme);
};

export const getInitialTheme = (): 'light' | 'dark' => {
  if (typeof window === 'undefined') return 'light';
  return (localStorage.getItem('theme') as 'light' | 'dark') || 'light';
};
