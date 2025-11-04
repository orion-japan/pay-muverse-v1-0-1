'use client';

export type QPieAppearance = 'none' | 'segment' | 'ring';

type Counts = { Q1: number; Q2: number; Q3: number; Q4: number; Q5: number };
type PolarityCounts = Record<keyof Counts, { ease: number; now: number }>;

const COLORS: Record<keyof Counts, string> = {
  Q1: '#7b8da4', // 秩序
  Q2: '#5aa06a', // 成長
  Q3: '#c2a05a', // 安定
  Q4: '#5a88c2', // 浄化
  Q5: '#c25a5a', // 情熱
};

// Ease（陰）用に淡い色を生成
function easeColor(hex: string, alpha = 0.45) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// 少し明るい色を返す（セグメント用グラデの終点）
function tint(hex: string, k = 0.35) {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const to = (v: number) => Math.round(v + (255 - v) * k);
  return `#${to(r).toString(16).padStart(2, '0')}${to(g).toString(16).padStart(2, '0')}${to(b).toString(16).padStart(2, '0')}`;
}

export default function QPie({
  counts,
  appearance = 'none',
  polarityCounts,
}: {
  counts: Counts;
  appearance?: QPieAppearance;
  polarityCounts?: PolarityCounts;
}) {
  // polarityCounts があればそれを優先して合計を作る
  const totalRaw = polarityCounts
    ? Object.values(polarityCounts).reduce((a, { ease, now }) => a + ease + now, 0)
    : counts.Q1 + counts.Q2 + counts.Q3 + counts.Q4 + counts.Q5;

  const hasData = totalRaw > 0;

  // ===================
  // appearance: "ring"
  // ===================
  if (appearance === 'ring') {
    const segments: { key: string; value: number; color: string }[] = [];

    if (polarityCounts) {
      (Object.keys(polarityCounts) as (keyof Counts)[]).forEach((q) => {
        const { ease, now } = polarityCounts[q];
        if (ease > 0) segments.push({ key: `${q}-ease`, value: ease, color: easeColor(COLORS[q]) });
        if (now > 0) segments.push({ key: `${q}-now`, value: now, color: COLORS[q] });
      });
    } else {
      (Object.keys(counts) as (keyof Counts)[]).forEach((q) => {
        if (counts[q] > 0) segments.push({ key: q, value: counts[q], color: COLORS[q] });
      });
    }

    const stops: string[] = [];
    let acc = 0;
    segments.forEach((s) => {
      const start = (acc / Math.max(1, totalRaw)) * 100;
      acc += s.value;
      const end = (acc / Math.max(1, totalRaw)) * 100;
      stops.push(`${s.color} ${start}% ${end}%`);
    });

    const bg =
      stops.length > 0 ? `conic-gradient(${stops.join(',')})` : `conic-gradient(#eef1f6 0 100%)`;

    const size = 300;
    const stroke = 24; // リングの太さ
    const inner = size - stroke * 2;

    return (
      <div style={{ position: 'relative', width: size, height: size }}>
        <div
          style={{
            width: size,
            height: size,
            borderRadius: '50%',
            background: bg,
          }}
          aria-label="Qコード分布（リング）"
        />
        {/* 内側をくり抜いてドーナツにする */}
        <div
          style={{
            position: 'absolute',
            left: stroke,
            top: stroke,
            width: inner,
            height: inner,
            borderRadius: '50%',
            background: '#fff',
          }}
        />
        {/* 中央テキスト */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            pointerEvents: 'none',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 700, color: '#334', lineHeight: 1 }}>
            {' '}
            {totalRaw}{' '}
          </div>
          <div style={{ fontSize: 12, color: '#667', marginTop: 2 }}>件</div>
        </div>
      </div>
    );
  }

  // ===================
  // SVG ドーナツ
  // ===================
  const total = hasData ? totalRaw : 1;
  const radius = 110;
  const stroke = 24;
  const cx = 150,
    cy = 150,
    r = radius;

  // セグメント用データ
  const entries: { key: string; value: number; color: string }[] = [];

  if (polarityCounts) {
    (Object.keys(polarityCounts) as (keyof Counts)[]).forEach((q) => {
      const { ease, now } = polarityCounts[q];
      if (ease > 0) entries.push({ key: `${q}-ease`, value: ease, color: easeColor(COLORS[q]) });
      if (now > 0) entries.push({ key: `${q}-now`, value: now, color: COLORS[q] });
    });
  } else {
    (Object.keys(counts) as (keyof Counts)[]).forEach((q) => {
      if (counts[q] > 0) entries.push({ key: q, value: counts[q], color: COLORS[q] });
    });
  }

  let acc = 0;
  const segs = entries.map(({ key, value, color }) => {
    const ratio = value / total;
    const angle = ratio * Math.PI * 2;
    const start = acc;
    acc += angle;
    return { key, start, angle, value, color };
  });

  const arc = (start: number, angle: number) => {
    const s = start - Math.PI / 2;
    const e = s + angle;
    const x1 = cx + r * Math.cos(s),
      y1 = cy + r * Math.sin(s);
    const x2 = cx + r * Math.cos(e),
      y2 = cy + r * Math.sin(e);
    const large = angle > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  return (
    <svg width={300} height={300} viewBox="0 0 300 300" role="img" aria-label="Qコード分布">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#eef1f6" strokeWidth={stroke} />

      {hasData &&
        segs.map((s, i) => {
          if (s.value <= 0) return null;
          return (
            <path
              key={s.key}
              d={arc(s.start, s.angle)}
              stroke={s.color}
              strokeWidth={stroke}
              fill="none"
              strokeLinecap="round"
            />
          );
        })}

      <text x={cx} y={cy - 4} textAnchor="middle" fontSize="20" fontWeight="700" fill="#334">
        {totalRaw}
      </text>
      <text x={cx} y={cy + 18} textAnchor="middle" fontSize="12" fill="#667">
        件
      </text>
    </svg>
  );
}
