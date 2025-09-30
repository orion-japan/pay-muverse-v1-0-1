'use client';

type QLog = {
  for_date: string;
  created_at?: string;
  q_code: { currentQ?: 'Q1'|'Q2'|'Q3'|'Q4'|'Q5'; depthStage?: string };
  intent?: string;
};

const Q_VAL: Record<string, number> = { Q1:1, Q2:2, Q3:3, Q4:4, Q5:5 };

export default function QDayTimeline({ logs }: { logs: QLog[] }) {
  // created_at で並べ、なければ元順
  const ordered = [...logs].sort((a,b)=>{
    if(!a.created_at || !b.created_at) return 0;
    return (new Date(a.created_at).getTime()) - (new Date(b.created_at).getTime());
  });

  const width = 300, height = 140, pad = 18;
  const n = Math.max(1, ordered.length);
  const x = (i: number) => pad + (i*(width - pad*2))/Math.max(1, n-1);
  const y = (q?: string) => {
    const v = Q_VAL[q ?? ''] ?? 0; // 1..5
    if (v === 0) return height - pad;
    const minY = pad, maxY = height - pad;
    const t = (v - 1) / 4; // 0..1
    return maxY - t*(maxY - minY);
  };

  const points = ordered.map((it, i) => `${x(i)},${y(it.q_code?.currentQ)}`).join(' ');

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="日別タイムライン">
      {/* 軸（Yの目盛り：Q1..Q5） */}
      {[1,2,3,4,5].map(v=>{
        const yy = y(`Q${v}`);
        return (
          <g key={v}>
            <line x1={pad} y1={yy} x2={width-pad} y2={yy} stroke="#eef1f6" />
            <text x={8} y={yy+4} fontSize="10" fill="#667">Q{v}</text>
          </g>
        );
      })}

      {/* 折れ線 */}
      {ordered.length > 0 && (
        <polyline
          points={points}
          fill="none"
          stroke="#6f86ff"
          strokeWidth="2"
        />
      )}

      {/* 点 */}
      {ordered.map((it, i)=>(
        <circle
          key={i}
          cx={x(i)}
          cy={y(it.q_code?.currentQ)}
          r="3.5"
          fill="#6f86ff"
        >
          <title>{`${it.q_code?.currentQ ?? '-'} ${it.q_code?.depthStage ? `· ${it.q_code.depthStage}` : ''}`}</title>
        </circle>
      ))}

      {/* 件数 */}
      <text x={width-pad} y={pad-4} textAnchor="end" fontSize="11" fill="#556">
        {ordered.length}件
      </text>
    </svg>
  );
}
