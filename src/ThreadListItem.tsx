// ThreadListItem.tsx （各ポスト行に設置する想定）
import { useState } from 'react';

type Counts = Record<string, number>;

export default function ResonanceRow({
  postId,
  initialCounts = {},
}: {
  postId: string;
  initialCounts?: Counts;
}) {
  const [counts, setCounts] = useState<Counts>(initialCounts);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  const types = [
    { key: 'heart', label: '❤️' },
    { key: 'empathy', label: '🤝' },
    { key: 'support', label: '📣' },
    { key: 'insight', label: '💡' },
  ];

  const toggle = async (resonanceType: string) => {
    try {
      setLoadingKey(resonanceType);
      const qCode = {
        actor_user_code: '<<YourUserCode>>', // 実際はContextから
        resonance_type: resonanceType,
        phase: 'Seed Flow',
        vector: 'Inner',
        depth: 'S2',
        intent: 'UI-Tap',
        ts: new Date().toISOString(),
      };

      const res = await fetch('/api/resonance/toggle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-code': '<<YourUserCode>>', // 仮。実装ではAuthから供給
        },
        body: JSON.stringify({ postId, resonanceType, qCode }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'failed');

      setCounts(json.counts || {});
    } catch (e) {
      console.error('[resonance toggle error]', e);
    } finally {
      setLoadingKey(null);
    }
  };

  return (
    <div className="resonance-row">
      {types.map((t) => (
        <button
          key={t.key}
          className={`resonance-btn ${loadingKey === t.key ? 'loading' : ''}`}
          onClick={() => toggle(t.key)}
          disabled={loadingKey !== null}
          title={t.key}
        >
          <span className="icon">{t.label}</span>
          <span className="count">{counts[t.key] ?? 0}</span>
        </button>
      ))}
      <style jsx>{`
        .resonance-row {
          display: flex;
          gap: 10px;
          align-items: center;
          padding: 6px 0;
        }
        .resonance-btn {
          border: 1px solid #e5e5ee;
          border-radius: 16px;
          padding: 6px 10px;
          background: #fff;
          cursor: pointer;
          display: flex;
          gap: 6px;
          align-items: center;
        }
        .resonance-btn.loading {
          opacity: 0.5;
          pointer-events: none;
        }
        .icon {
          font-size: 16px;
          line-height: 1;
        }
        .count {
          font-size: 12px;
          color: #555;
        }
      `}</style>
    </div>
  );
}
