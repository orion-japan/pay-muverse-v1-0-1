// components/MyReactionsCard.tsx
"use client";
import { useEffect, useState } from "react";

type ReactionSummary = {
  total: number;
  breakdown: { reaction: string; count: number }[];
};

export default function MyReactionsCard({ user_code }: { user_code: string }) {
  const [summary, setSummary] = useState<ReactionSummary | null>(null);

  useEffect(() => {
    fetch(`/api/reactions/summary?user_code=${user_code}`)
      .then(res => res.json())
      .then(data => setSummary(data));
  }, [user_code]);

  if (!summary) return <div className="p-4">読み込み中...</div>;

  return (
    <div className="p-4 bg-white rounded-2xl shadow-md">
      <h2 className="text-lg font-bold mb-2">イイネ群カード</h2>
      <p className="mb-2">合計: <strong>{summary.total}</strong></p>
      <div className="grid grid-cols-2 gap-2">
        {summary.breakdown.map(r => (
          <div key={r.reaction} className="flex justify-between p-2 bg-gray-100 rounded-lg">
            <span>{r.reaction}</span>
            <span>{r.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
