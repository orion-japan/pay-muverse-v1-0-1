// src/lib/iros/remember/PeriodBundleList.tsx
import React from 'react';

export type PeriodType = 'day' | 'week' | 'month';

export type ResonancePeriodBundle = {
  id: string;
  period_type: PeriodType;
  period_start: string;
  period_end: string;
  title: string | null;
  summary: string | null;
  q_dominant: string | null;
  q_stats: Record<string, number> | null;
  depth_stats: Record<string, number> | null;
  topics: string[] | null;
  created_at?: string | null;
};

type Props = {
  bundles: ResonancePeriodBundle[];
  onSelectBundle?: (bundle: ResonancePeriodBundle) => void;
};

function formatDateRange(start: string, end: string) {
  const s = new Date(start);
  const e = new Date(end);

  const toYmd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;

  if (toYmd(s) === toYmd(e)) return toYmd(s);

  return `${toYmd(s)} 〜 ${toYmd(e)}`;
}

function renderStats(stats: Record<string, number> | null | undefined) {
  if (!stats) return null;

  const entries = Object.entries(stats);
  if (entries.length === 0) return null;

  return (
    <div style={{ fontSize: 12, marginTop: 4, opacity: 0.8 }}>
      {entries.map(([key, value]) => (
        <span key={key} style={{ marginRight: 8 }}>
          <strong>{key}</strong>: {value}
        </span>
      ))}
    </div>
  );
}

export const PeriodBundleList: React.FC<Props> = ({ bundles, onSelectBundle }) => {
  if (!bundles || bundles.length === 0) {
    return (
      <div
        style={{
          padding: '16px 12px',
          borderRadius: 8,
          border: '1px solid #ddd',
          fontSize: 14,
          color: '#666',
        }}
      >
        まだ Remember バンドルは作成されていません。
        <br />
        「昨日のあれなんだっけ？」などで生成されます。
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {bundles.map((b) => {
        const handleClick = () => onSelectBundle?.(b);

        const topics = (b.topics ?? []).slice(0, 5);

        return (
          <div
            key={b.id}
            onClick={onSelectBundle ? handleClick : undefined}
            style={{
              borderRadius: 10,
              border: '1px solid #ddd',
              padding: 12,
              cursor: onSelectBundle ? 'pointer' : 'default',
              backgroundColor: '#fafafa',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: 4,
              }}
            >
              <div style={{ fontSize: 13, color: '#555' }}>
                {b.period_type.toUpperCase()} | {formatDateRange(b.period_start, b.period_end)}
              </div>
              {b.q_dominant && (
                <div
                  style={{
                    fontSize: 12,
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: '1px solid #ccc',
                    backgroundColor: '#fff',
                  }}
                >
                  Q: {b.q_dominant}
                </div>
              )}
            </div>

            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
              {b.title || '(タイトル未設定)'}
            </div>

            {b.summary && (
              <div style={{ fontSize: 14, color: '#444', marginBottom: 4 }}>{b.summary}</div>
            )}

            {topics.length > 0 && (
              <div style={{ fontSize: 12, marginTop: 4 }}>
                <span style={{ marginRight: 4, color: '#777' }}>Topics:</span>
                {topics.map((t, idx) => (
                  <span key={idx} style={{ marginRight: 6 }}>
                    #{t}
                  </span>
                ))}
                {b.topics && b.topics.length > topics.length && <span>…</span>}
              </div>
            )}

            {renderStats(b.q_stats)}
            {renderStats(b.depth_stats)}
          </div>
        );
      })}
    </div>
  );
};
