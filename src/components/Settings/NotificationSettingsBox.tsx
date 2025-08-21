'use client';

import { useEffect, useState } from 'react';
import { getAuth } from 'firebase/auth';

type Plan = 'free' | 'regular' | 'premium' | 'master' | 'admin';

type Props = {
  planStatus: Plan;
};

export default function ShipVisibilityBox({ planStatus }: Props) {
  const [loading, setLoading] = useState(true);
  const [visibility, setVisibility] = useState<'pair' | 'friends' | 'all'>('pair');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const ac = new AbortController();

    (async () => {
      try {
        const auth = getAuth();
        const user = auth.currentUser;
        if (!user) {
          setLoading(false);
          return;
        }
        const token = await user.getIdToken(true);

        const res = await fetch('/api/ship-visibility', {
          method: 'GET',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: ac.signal,
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`GET /api/ship-visibility failed: ${res.status}`);
        const data = await res.json();
        if (!mounted) return;
        setVisibility(data?.ship_visibility ?? 'pair');
      } catch (e: any) {
        if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') {
          // ページ遷移などで中断された場合は無視
          return;
        }
        console.error(e);
        if (mounted) setErrorMsg('読み込みに失敗しました');
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
      ac.abort();
    };
  }, []);

  const handleChange = async (newValue: 'pair' | 'friends' | 'all') => {
    try {
      const auth = getAuth();
      const user = auth.currentUser;
      if (!user) return;
      const token = await user.getIdToken(true);

      const res = await fetch('/api/ship-visibility', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ ship_visibility: newValue }),
      });
      if (!res.ok) throw new Error(`POST failed: ${res.status}`);
      setVisibility(newValue);
    } catch (e) {
      console.error(e);
      setErrorMsg('保存に失敗しました');
    }
  };

  if (loading) {
    return <div>読み込み中...</div>;
  }

  return (
    <div className="ship-visibility-box">
      <h3>シップの公開範囲</h3>
      <select
        value={visibility}
        onChange={(e) => handleChange(e.target.value as 'pair' | 'friends' | 'all')}
      >
        <option value="pair">ペアのみ</option>
        <option value="friends">シップメイトまで</option>
        <option value="all">全体公開</option>
      </select>
      {errorMsg && <div className="error">{errorMsg}</div>}
    </div>
  );
}
