// src/hooks/useReactionCounts.ts
'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type Totals = { like: number; heart: number; smile: number; wow: number; share: number };
const ZERO: Totals = { like: 0, heart: 0, smile: 0, wow: 0, share: 0 };

/* -------- Supabase client (singleton on the browser) -------- */
function getBrowserSupabase(): SupabaseClient | null {
  if (typeof window === 'undefined') return null;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null;
  const g = window as unknown as { __sb_rx?: SupabaseClient };
  if (!g.__sb_rx) {
    g.__sb_rx = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );
  }
  return g.__sb_rx;
}
const sb = getBrowserSupabase();

/* =========================================================
   Hook
========================================================= */
export function useReactionCounts(postId?: string, opts?: { isParent?: boolean }) {
  const [totals, setTotals] = useState<Totals>(ZERO);
  const [loading, setLoading] = useState(false);
  const isParent = !!opts?.isParent;

  const url = useMemo(() => {
    if (!postId) return '';
    const q = new URLSearchParams({ post_id: postId, is_parent: String(isParent) });
    return `/api/reactions/counts?${q.toString()}`;
  }, [postId, isParent]);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (!url) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json().catch(() => ({} as any));
      const t = j?.totals ?? {};
      if (!mountedRef.current) return;
      setTotals({
        like: Number(t.like ?? 0),
        heart: Number(t.heart ?? 0),
        smile: Number(t.smile ?? 0),
        wow: Number(t.wow ?? 0),
        share: Number(t.share ?? 0),
      });
    } catch {
      if (!mountedRef.current) return;
      // 失敗時は安全側でゼロ（UI一貫性優先）
      setTotals(ZERO);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [url]);

  // 初回ロード
  useEffect(() => {
    mountedRef.current = true;
    if (url) load();
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, [url, load]);

  // Realtime: reactions テーブルの対象 post_id の変更だけ反応
  useEffect(() => {
    if (!sb || !postId) return;
    let timer: any = null;
    const debouncedLoad = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 200);
    };

    const ch = sb
      .channel(`rx-post-${postId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'reactions', filter: `post_id=eq.${postId}` },
        debouncedLoad
      )
      .subscribe();

    return () => {
      clearTimeout(timer);
      sb.removeChannel(ch);
    };
  }, [postId, load]);

  // 明示リフレッシュ（トグル成功後に即反映したい時用）
  useEffect(() => {
    const h = (e: CustomEvent<{ post_id?: string }>) => {
      const pid = e?.detail?.post_id;
      if (!postId || !pid || pid !== postId) return;
      load();
    };
    // 型ガードの都合で as を付ける（構造は維持）
    window.addEventListener('reactions:refresh', h as unknown as EventListener);
    return () => window.removeEventListener('reactions:refresh', h as unknown as EventListener);
  }, [postId, load]);

  return { totals, loading, reload: load };
}
