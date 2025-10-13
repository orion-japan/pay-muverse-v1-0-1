// src/hooks/useEntitlement.ts
import { useEffect, useState } from 'react';

type Ent = { bundle: boolean; p2: boolean; p3: boolean; p4: boolean; updatedAt: string | null };
type Prices = { phase2: number; phase3: number; phase4: number; bundle234: number };

export function useEntitlement(userId: string | null | undefined) {
  const [loading, setLoading] = useState(false);
  const [entitlement, setEntitlement] = useState<Ent | null>(null);
  const [prices, setPrices] = useState<Prices | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/entitlement/check`, {
        headers: { 'x-user-id': userId },
        cache: 'no-store',
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'fetch_failed');
      setEntitlement(j.entitlement);
      setPrices(j.prices);
    } catch (e: any) {
      setError(e?.message ?? 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [userId]);

  return { loading, entitlement, prices, error, refresh };
}
