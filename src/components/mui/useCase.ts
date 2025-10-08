import { useCallback, useEffect, useState } from "react";
import type { Quartet } from "./types";

export function useCase(userCode: string) {
  const [seedId, setSeedId] = useState<string | null>(null);
  const [quartet, setQuartet] = useState<Quartet | null>(null);
  const [loading, setLoading] = useState(false);

  const genSeed = useCallback(() => {
    const d = new Date();
    const ymd = [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('');
    return `CASE-${ymd}-${Math.random().toString(36).slice(2,6)}`;
  },[]);

  const ensureSeed = useCallback(() => {
    if (!seedId) setSeedId(genSeed());
  }, [seedId, genSeed]);

  const fetchQuartet = useCallback(async (seed: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/mui/case/${encodeURIComponent(seed)}/quartet`);
      const data = await res.json();
      if (data?.ok) setQuartet(data.quartet);
    } finally {
      setLoading(false);
    }
  },[]);

  const saveStage = useCallback(async (payload: {
    seed_id: string; sub_id: 'stage1'|'stage2'|'stage3'|'stage4';
    partner_detail: string; tone: any; next_step: string;
    currentQ?: string; depthStage?: string; phase?: 'Inner'|'Outer'|'Mixed'; self_accept?: number;
  }) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/mui/stage/save`, {
        method: 'POST', headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ user_code: userCode, ...payload })
      });
      const data = await res.json();
      if (data?.ok) setQuartet(data.quartet);
      return data;
    } finally {
      setLoading(false);
    }
  }, [userCode]);

  return { seedId, setSeedId, ensureSeed, quartet, fetchQuartet, saveStage, loading };
}
