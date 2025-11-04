'use client';
export default function MuFullLayout({ children }: { children: React.ReactNode }) {
  // 親レイアウトのボックス幅などに干渉しないように
  return <div style={{ display: 'contents' }}>{children}</div>;
}
