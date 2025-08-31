import SofiaChat from '@/components/SofiaChat/SofiaChat';

export const dynamic = 'force-dynamic';

export default function SofiaPage() {
  return (
    <main className="mu-main">
      {/* 幅や余白は CSS の .sofia-page-wrap 側で管理 */}
      <div className="sofia-page-wrap">
        <SofiaChat />
      </div>
    </main>
  );
}
