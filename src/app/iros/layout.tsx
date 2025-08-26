// app/iros/layout.tsx
'use client';
export default function IrosLayout({ children }: { children: React.ReactNode }) {
  // 親の <html>/<body> を使う
  return <div style={{ display: 'contents' }}>{children}</div>;
}
