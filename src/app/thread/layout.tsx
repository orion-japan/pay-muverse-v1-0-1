// サブアプリ用の薄いラッパ。ここでスコープを分けて他ページのCSS干渉を避ける
import './layout.css';

export default function ThreadLayout({ children }: { children: React.ReactNode }) {
  return <div className="thread-shell">{children}</div>;
}
