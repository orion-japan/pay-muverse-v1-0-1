// src/app/sofia/layout.tsx
import '@/components/SofiaChat/SofiaChat.css';

export default function SofiaLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="sofia-container">
      {children}
    </div>
  );
}
