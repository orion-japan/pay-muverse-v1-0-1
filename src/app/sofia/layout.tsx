import '@/components/SofiaChat/SofiaChat.css';

export default function SofiaLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="sofia-container">
      {/* PC時に中央レーンを作るためのラッパ */}
      <div className="sof-center">{children}</div>
    </div>
  );
}
