import SofiaChat from '@/components/SofiaChat/SofiaChat';

export const dynamic = 'force-dynamic';

export default function SofiaPage() {
  return (
    <main className="mu-main">
      {/* 幅や余白は CSS の .sofia-page-wrap 側で管理 */}
      <div className="sofia-page-wrap">
        {/* ★ Mu 固定（SofiaChat 側でデフォルト 'mu'。prop未対応でもOK） */}
        <SofiaChat agent="mu" />
      </div>
    </main>
  );
}
