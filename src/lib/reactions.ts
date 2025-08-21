// /src/lib/reactions.ts
export type ReactionTotals = {
    like: number;
    heart: number;
    smile: number;
    wow: number;
    share: number;
  };
  
  const EMPTY: ReactionTotals = { like: 0, heart: 0, smile: 0, wow: 0, share: 0 };
  
  /** 親カード用：Self/Thread共通。これだけを親の表示に使う */
  export async function fetchParentTotals(parentPostId: string): Promise<ReactionTotals> {
    const url = `/api/reactions/counts?scope=post&post_id=${encodeURIComponent(parentPostId)}&is_parent=true`;
    console.log('[REACTIONS] parent call', url);
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      return (j?.totals as ReactionTotals) ?? EMPTY;
    } catch (e) {
      console.error('[REACTIONS] parent error', e);
      return EMPTY;
    }
  }
  
  /** 子カード用：Thread側の各返信の表示に使う */
  export async function fetchChildTotals(childPostId: string): Promise<ReactionTotals> {
    const url = `/api/reactions/counts?scope=post&post_id=${encodeURIComponent(childPostId)}&is_parent=false`;
    console.log('[REACTIONS] child call', url);
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      return (j?.totals as ReactionTotals) ?? EMPTY;
    } catch (e) {
      console.error('[REACTIONS] child error', e);
      return EMPTY;
    }
  }
  
  /** （任意）スレッド累積：親+子の合算を別表示で見せたい時だけ使う */
  export async function fetchThreadTotals(threadId: string): Promise<ReactionTotals> {
    const url = `/api/reactions/counts?scope=thread&thread_id=${encodeURIComponent(threadId)}`;
    console.log('[REACTIONS] thread-merged call', url);
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      return (j?.totals as ReactionTotals) ?? EMPTY;
    } catch (e) {
      console.error('[REACTIONS] thread-merged error', e);
      return EMPTY;
    }
  }
  