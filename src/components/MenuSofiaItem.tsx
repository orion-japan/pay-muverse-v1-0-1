'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchWithIdToken } from '@/lib/fetchWithIdToken';

export default function MenuSofiaItem() {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetchWithIdToken('/api/guard/sofia');
        if (!alive) return;
        setAllowed(r.ok);
      } catch {
        if (!alive) return;
        setAllowed(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const style: React.CSSProperties =
    allowed === null
      ? { opacity: 0.4, pointerEvents: 'none' }   // チェック中は押せない
      : allowed
      ? {}
      : { opacity: 0.35, pointerEvents: 'none' }; // 非会員は押せない

  return (
    <Link href="/sofia" style={{ textDecoration: 'none', ...style }}>
      <div style={{
        padding: '10px 12px',
        borderRadius: 12,
        border: '1px solid #e6e6e6'
      }}>
        Sofia
      </div>
    </Link>
  );
}
