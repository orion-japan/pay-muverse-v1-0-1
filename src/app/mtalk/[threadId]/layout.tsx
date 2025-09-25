// src/app/mtalk/[threadId]/layout.tsx
import '@/components/SofiaChat/SofiaChat.css';

export default function MTalkThreadLayout({ children }: { children: React.ReactNode }) {
  // ← チャット画面だけ Sofia の中央レイアウトを適用
  return (
    <div className="sofia-container">
      <div className="sof-center">{children}</div>
    </div>
  );
}
