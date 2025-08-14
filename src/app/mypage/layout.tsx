// src/app/mypage/layout.tsx
import './mypage.css';

export default function MyPageLayout({ children }: { children: React.ReactNode }) {
  return <div className="mypage-wrapper">{children}</div>;
}
