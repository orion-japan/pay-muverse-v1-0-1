'use client';

type Counts = Record<'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5', { yin: number; yang: number }>;

const Q_COLOR: Record<'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5', string> = {
  Q1: '#7b8da4',
  Q2: '#5aa06a',
  Q3: '#c2a05a',
  Q4: '#5a88c2',
  Q5: '#c25a5a',
};

export default function QYinYangBars({ counts }: { counts: Counts }) {
  const rows = (['Q1', 'Q2', 'Q3', 'Q4', 'Q5'] as const).map((q) => {
    const v = counts[q];
    const total = v.yin + v.yang;
    const yinPct = total ? Math.round((v.yin / total) * 100) : 0;
    const yangPct = total ? Math.round((v.yang / total) * 100) : 0;
    return { q, total, yin: v.yin, yang: v.yang, yinPct, yangPct, color: Q_COLOR[q] };
  });

  const max = Math.max(1, ...rows.map((r) => r.total));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {rows.map(({ q, total, yin, yang, yinPct, yangPct, color }) => (
        <div key={q} style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>{q}</span>
            <span style={{ color: '#566' }}>
              {total}件（陰{yin} / 陽{yang}）
            </span>
          </div>
          <div
            style={{
              width: '100%',
              height: 14,
              borderRadius: 7,
              background: '#eef1f6',
              overflow: 'hidden',
              border: '1px solid #e2e7f0',
            }}
          >
            {/* 陰（やや薄） */}
            <div
              style={{
                width: `${(yin / max) * 100}%`,
                height: '100%',
                background: color + '99',
                display: 'inline-block',
              }}
            />
            {/* 陽（濃い） */}
            <div
              style={{
                width: `${(yang / max) * 100}%`,
                height: '100%',
                background: color,
                display: 'inline-block',
              }}
            />
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 12,
              color: '#667',
            }}
          >
            <span>陰 {yinPct}%</span>
            <span>陽 {yangPct}%</span>
          </div>
        </div>
      ))}
      <div
        style={{
          marginTop: 4,
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          fontSize: 12,
          color: '#667',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i
            style={{
              width: 12,
              height: 12,
              background: '#999',
              opacity: 0.6,
              borderRadius: 3,
              display: 'inline-block',
            }}
          ></i>{' '}
          陰
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i
            style={{
              width: 12,
              height: 12,
              background: '#999',
              borderRadius: 3,
              display: 'inline-block',
            }}
          ></i>{' '}
          陽
        </span>
      </div>
    </div>
  );
}
