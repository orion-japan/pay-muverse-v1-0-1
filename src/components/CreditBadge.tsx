'use client';
import { useEffect, useState } from 'react';

export default function CreditBadge({ userCode }: { userCode: string }) {
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/credits/balance?user_code=${encodeURIComponent(userCode)}`, { cache: 'no-store' });
      const j = await res.json();
      if (j.ok) setBalance(j.balance);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [userCode]);

  return (
    <button onClick={load} title="残高を再読込" style={{
      border:'1px solid #ddd', borderRadius:12, padding:'6px 10px',
      background:'#fff', fontFamily:'system-ui', fontSize:14
    }}>
      💳 {loading ? '…' : (balance ?? '—')} pt
    </button>
  );
}
