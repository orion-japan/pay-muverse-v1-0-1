// Server Component のまま（use client は付けない）
export const dynamic = 'force-dynamic';

import './mu-logs.css'; // 下で追加するCSSを読み込む

export default function MuLogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 親のスマホ幅制約を“見かけ上”突破して、内部だけPC幅にする
  return (
    <div className="mu-logs-bleed">
      <div className="mu-logs-inner">{children}</div>
    </div>
  );
}
