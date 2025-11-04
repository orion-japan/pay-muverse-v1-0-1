// src/app/<route>/layout.tsx
import type { Metadata, Viewport } from 'next';

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)',  color: '#111111' },
  ],
};

export const metadata: Metadata = {
  title: '<Route Title>',
  description: '<Route Description>',
  // ❌ themeColor はここに書かない
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
