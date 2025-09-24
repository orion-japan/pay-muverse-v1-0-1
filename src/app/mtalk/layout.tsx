// src/app/mtalk/layout.tsx
import '@/components/SofiaChat/SofiaChat.css';

export default function MTalkLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="sofia-container">
      <div className="sof-center">{children}</div>
    </div>
  );
}
