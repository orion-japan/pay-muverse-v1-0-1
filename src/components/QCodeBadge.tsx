// src/components/QCodeBadge.tsx
'use client';
import { useEffect, useState } from 'react';
import './QCodeBadge.css';

type QCode = {
  user_code: string;
  s_ratio: number;
  r_ratio: number;
  c_ratio: number;
  i_ratio: number;
  si_balance: number;
  traits?: Record<string, any>;
  updated_at?: string;
};

export default function QCodeBadge({ userCode }: { userCode: string }) {
  const [q, setQ] = useState<QCode | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`/api/qcode/${encodeURIComponent(userCode)}/get`, {
          cache: 'no-store',
        });
        const json = await res.json();
        if (mounted) setQ(json?.qcode ?? null);
      } catch {
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [userCode]);

  if (loading) return <div className="qcode-badge">Q •••</div>;
  if (!q) return <div className="qcode-badge muted">Q 未設定</div>;

  // 簡易スコア：平均
  const avg = Math.round(((q.s_ratio + q.r_ratio + q.c_ratio + q.i_ratio) / 4) * 100) / 100;

  return (
    <div
      className="qcode-badge"
      title={`S:${q.s_ratio} R:${q.r_ratio} C:${q.c_ratio} I:${q.i_ratio} / SI:${q.si_balance}`}
    >
      <span className="q-title">Q</span>
      <div className="bars">
        <div className="bar s" style={{ width: `${q.s_ratio * 100}%` }} />
        <div className="bar r" style={{ width: `${q.r_ratio * 100}%` }} />
        <div className="bar c" style={{ width: `${q.c_ratio * 100}%` }} />
        <div className="bar i" style={{ width: `${q.i_ratio * 100}%` }} />
      </div>
      <span className="q-avg">{avg}</span>
    </div>
  );
}
