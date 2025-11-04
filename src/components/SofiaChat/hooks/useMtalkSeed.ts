import { useCallback, useEffect, useRef } from 'react';
import type { Message } from '../types';

export function useMtalkSeed(urlFrom?: string, urlCid?: string, urlSummary?: string) {
  const mtalkSeedRef = useRef<string | null>(null);

  useEffect(() => {
    if (urlFrom !== 'mtalk') return;
    let seed = '';
    if (typeof window !== 'undefined' && urlCid) {
      const ss = sessionStorage.getItem(`mtalk:seed:${urlCid}`);
      if (ss) seed = ss;
    }
    if (!seed && urlSummary) seed = decodeURIComponent(urlSummary);
    if (seed && typeof window !== 'undefined' && urlCid) {
      try {
        sessionStorage.removeItem(`mtalk:seed:${urlCid}`);
      } catch {}
    }
    if (seed) mtalkSeedRef.current = seed;
  }, [urlFrom, urlCid, urlSummary]);

  const inject = useCallback((rows: Message[], convId?: string): Message[] => {
    const seed = mtalkSeedRef.current;
    if (!seed) return rows;
    if (rows.length && (rows[0] as any)?.meta?.from === 'mtalk') return rows;
    const sysMsg: Message = {
      id: `mtalk-seed-${convId || Date.now()}`,
      role: 'system',
      content: `【mTalkからの共有】\n${seed}`,
      created_at: new Date().toISOString(),
      meta: { from: 'mtalk' },
      free: true,
    };
    mtalkSeedRef.current = null;
    return [sysMsg, ...rows];
  }, []);

  return { inject };
}
