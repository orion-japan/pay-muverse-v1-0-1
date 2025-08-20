// src/hooks/useReactionCounts.ts
'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';

type Totals = { like: number; heart: number; smile: number; wow: number; share: number };
const ZERO: Totals = { like: 0, heart: 0, smile: 0, wow: 0, share: 0 };

const sb =
  typeof window !== 'undefined' &&
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ? createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      )
    : null;

export function useReactionCounts(postId?: string, opts?: { isParent?: boolean }) {
  const [totals, setTotals] = useState<Totals>(ZERO);
  const [loading, setLoading] = useState(false);
  const isParent = !!opts?.isParent;

  const url = useMemo(() => {
    if (!postId) return '';
    const q = new URLSearchParams({ post_id: postId, is_parent: String(isParent) });
    return `/api/reactions/counts?${q.toString()}`;
  }, [postId, isParent]);

  const load = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try {
      const res = await fetch(url, { cache: 'no-store' });
      const j = await res.json().catch(() => ({}));
      const t = j?.totals ?? {};
      setTotals({
        like: Number(t.like ?? 0),
        heart: Number(t.heart ?? 0),
        smile: Number(t.smile ?? 0),
        wow: Number(t.wow ?? 0),
        share: Number(t.share ?? 0),
      });
    } finally {
      setLoading(false);
    }
  }, [url]);

  // 初回ロード
  useEffect(() => {
    load();
  }, [load]);

  // Realtime: reactions テーブルの対象 post_id の変更だけ反応
  useEffect(() => {
    if (!sb || !postId) return;
    const ch = sb
      .channel(`rx-post-${postId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'reactions', filter: `post_id=eq.${postId}` },
        () => load()
      )
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [postId, load]);

  // 明示リフレッシュ（トグル成功後に即反映したい時用）
  useEffect(() => {
    const h = (e: any) => {
      const pid = e?.detail?.post_id;
      if (!postId || !pid || pid !== postId) return;
      load();
    };
    window.addEventListener('reactions:refresh', h as EventListener);
    return () => window.removeEventListener('reactions:refresh', h as EventListener);
  }, [postId, load]);

  return { totals, loading, reload: load };
}
