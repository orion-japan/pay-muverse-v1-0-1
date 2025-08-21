// src/app/thread/[threadId]/page.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/context/AuthContext';
import ReactionBar from '@/components/ReactionBar';
import './ThreadPage.css';




/* ===== Types ===== */
type Post = {
  post_id: string;
  user_code: string | null;
  click_username?: string | null; // 表示名
  content?: string | null;
  created_at: string;
  media_urls?: string[] | null;
  is_posted?: boolean | null;
  thread_id?: string | null;
};

type ReactionCount = { r_type: string; count: number };

/* ===== Consts ===== */
const DEFAULT_AVATAR = '/iavatar_default.png';

/* ===== Page ===== */
export default function ThreadPage() {
  const router = useRouter();
  const { threadId } = useParams<{ threadId: string }>();
  const { userCode } = useAuth();

  const [parent, setParent] = useState<Post | null>(null);
  const [children, setChildren] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState('');
  const [newComment, setNewComment] = useState('');

  // 反応カウント（post_id -> ReactionCount[]）
  const [countsMap, setCountsMap] = useState<Record<string, ReactionCount[]>>({});
  const [countsVersion, setCountsVersion] = useState(0);

  const [avatarMap, setAvatarMap] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  const seenIds = useRef<Set<string>>(new Set());

  /* ===== Helpers ===== */
  type CountsLike = Partial<{ like: number; heart: number; smile: number; wow: number; share: number }>;
  const toCounts = (arr?: ReactionCount[] | null): CountsLike => {
    const out: CountsLike = { like: 0, heart: 0, smile: 0, wow: 0, share: 0 };
    if (!arr) return out;
    for (const a of arr) {
      const k = String(a?.r_type || '').toLowerCase();
      if (k in out) (out as any)[k] = a?.count ?? 0;
    }
    return out;
  };

  const avatarSrcFrom = (code?: string | null) => (code ? `/api/avatar/${encodeURIComponent(code)}` : DEFAULT_AVATAR);

  const onAvatarError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.currentTarget;
    if (el.dataset.fallbackApplied === '1') return;
    el.dataset.fallbackApplied = '1';
    el.src = new URL(DEFAULT_AVATAR, location.origin).toString();
  };

  const goProfile = (code?: string | null) => {
    if (!code) return;
    router.push(`/profile/${encodeURIComponent(code)}`);
  };

  async function hydrateFromProfiles(posts: Post[]) {
    const set = new Set<string>();
    for (const p of posts) {
      if (typeof p.user_code === 'string' && p.user_code.trim()) set.add(p.user_code);
    }
    const codes = Array.from(set);
    if (!codes.length) return posts;

    const { data: profRows, error: profErr } = await supabase
      .from('profiles')
      .select('user_code,name,avatar_url')
      .in('user_code', codes);

    if (profErr) {
      console.warn('[Thread] profiles fetch error', profErr);
      return posts;
    }

    const nameMap = new Map<string, string | null>();
    const addAvatars: Record<string, string> = {};
    (profRows || []).forEach((r: any) => {
      nameMap.set(r.user_code, r.name ?? null);
      if (r.avatar_url) addAvatars[r.user_code] = r.avatar_url as string;
    });
    setAvatarMap(prev => ({ ...prev, ...addAvatars }));

    return posts.map(p =>
      p.user_code ? { ...p, click_username: nameMap.get(p.user_code) ?? p.click_username ?? p.user_code } : p
    );
  }

  /* ===== Reaction counts ===== */
  const parentCountsUrl = (postId: string) =>
    `/api/reactions/counts?scope=post&post_id=${encodeURIComponent(postId)}&is_parent=true`;
  const childCountsUrl = (postId: string) =>
    `/api/reactions/counts?scope=post&post_id=${encodeURIComponent(postId)}&is_parent=false`;

  async function fetchCountsSingle(postId: string, isParent: boolean): Promise<ReactionCount[] | null> {
    const url = isParent ? parentCountsUrl(postId) : childCountsUrl(postId);
    console.log('[fetchCountsSingle] call', { postId, isParent, url });
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      const json = await res.json().catch(() => null);
      console.log('[fetchCountsSingle] resp', { postId, isParent, json });
      const totals: Record<string, number> | undefined = json && (json.totals || json.counts || json.data);
      if (!totals) return null;
      return Object.entries(totals).map(([r_type, count]) => ({ r_type, count: count ?? 0 }));
    } catch (err) {
      console.error('[fetchCountsSingle] error', err);
      return null;
    }
  }

  async function fetchCountsForParentAndChildren(parentId?: string, childIds: string[] = []) {
    const tasks: Array<Promise<[string, ReactionCount[] | null]>> = [];
    if (parentId) tasks.push(fetchCountsSingle(parentId, true).then(arr => [parentId, arr] as const));
    childIds.forEach(id => tasks.push(fetchCountsSingle(id, false).then(arr => [id, arr] as const)));

    const results = await Promise.all(tasks);
    setCountsMap(prev => {
      const next = { ...prev };
      for (const [id, arr] of results) next[id] = arr ?? prev[id] ?? [];
      return next;
    });
    setCountsVersion(v => v + 1);
  }

  /* ===== Initial load ===== */
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!threadId) return;
      try {
        setLoading(true);
        setErrMsg('');

        // 親
        const { data: pRow, error: pErr } = await supabase
          .from('posts')
          .select('post_id,user_code,content,created_at,media_urls,is_posted,thread_id')
          .eq('post_id', threadId)
          .single();
        if (pErr) throw pErr;

        // 子（昇順, 親除外）
        const { data: cRows, error: cErr } = await supabase
          .from('posts')
          .select('post_id,user_code,content,created_at,media_urls,is_posted,thread_id')
          .eq('thread_id', threadId)
          .order('created_at', { ascending: true });
        if (cErr) throw cErr;

        const onlyChildren = (cRows ?? []).filter(p => p.post_id !== threadId);

        const [hydratedParent] = await hydrateFromProfiles([pRow as Post]);
        const hydratedChildren = await hydrateFromProfiles(onlyChildren as Post[]);
        if (!mounted) return;

        setParent(hydratedParent);
        setChildren(hydratedChildren);

        await fetchCountsForParentAndChildren(
          hydratedParent?.post_id,
          hydratedChildren.map(p => p.post_id)
        );
      } catch (e: any) {
        console.error('[ThreadPage] init error', e);
        setErrMsg(e?.message || '読み込みに失敗しました');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [threadId]);

  /* ===== Realtime ===== */
  useEffect(() => {
    if (!threadId) return;

    const chPosts = supabase
      .channel(`thread_posts_${threadId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'posts', filter: `thread_id=eq.${threadId}` },
        async payload => {
          if (payload.eventType === 'INSERT') {
            const row = payload.new as Post;
            if (seenIds.current.has(row.post_id)) return;
            if (row.post_id === threadId) return; // 親は無視
            const [hydrated] = await hydrateFromProfiles([row]);
            setChildren(prev => (prev.some(p => p.post_id === row.post_id) ? prev : [...prev, hydrated]));
            seenIds.current.add(row.post_id);
            const arr = await fetchCountsSingle(row.post_id, false);
            setCountsMap(prev => ({ ...prev, [row.post_id]: arr ?? prev[row.post_id] ?? [] }));
            setCountsVersion(v => v + 1);
          }
        }
      )
      .subscribe(() => console.log('[ThreadPage] Realtime (posts) subscribed'));

    const chReactParent = supabase
      .channel(`reactions_parent_${threadId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'reactions', filter: `post_id=eq.${threadId}` },
        async () => {
          const arr = await fetchCountsSingle(String(threadId), true);
          setCountsMap(prev => ({ ...prev, [String(threadId)]: arr ?? prev[String(threadId)] ?? [] }));
          setCountsVersion(v => v + 1);
        }
      )
      .subscribe();

    const chReactThread = supabase
      .channel(`reactions_thread_${threadId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'reactions', filter: `thread_id=eq.${threadId}` },
        async payload => {
          const changed = (payload.new as any)?.post_id || (payload.old as any)?.post_id;
          if (!changed) return;
          if (String(changed) === String(threadId)) {
            const arr = await fetchCountsSingle(String(threadId), true);
            setCountsMap(prev => ({ ...prev, [String(threadId)]: arr ?? prev[String(threadId)] ?? [] }));
          } else {
            const arr = await fetchCountsSingle(String(changed), false);
            setCountsMap(prev => ({ ...prev, [String(changed)]: arr ?? prev[String(changed)] ?? [] }));
          }
          setCountsVersion(v => v + 1);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(chPosts);
      supabase.removeChannel(chReactParent);
      supabase.removeChannel(chReactThread);
    };
  }, [threadId]);

  /* ===== Auto scroll ===== */
  useEffect(() => {
    if (!listRef.current) return;
    const t = setTimeout(() => {
      listRef.current!.scrollTop = listRef.current!.scrollHeight;
    }, 40);
    return () => clearTimeout(t);
  }, [children.length]);

  useEffect(() => {
    if (!parent?.user_code) return;
    fetch(`/api/qcode/${encodeURIComponent(parent.user_code)}/get`).catch(() => {});
  }, [parent?.user_code]);

  const handlePost = async () => {
    setErrMsg('');
    try {
      const text = newComment.trim();
      if (!text || !userCode || !threadId) return;

      const res = await fetch('/api/thread/comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, userCode, content: text }),
      });
      if (!res.ok) throw new Error('投稿に失敗しました');

      const inserted = (await res.json()) as Post;
      setNewComment('');
      const [hydrated] = await hydrateFromProfiles([inserted]);
      setChildren(prev => (prev.some(p => p.post_id === inserted.post_id) ? prev : [...prev, hydrated]));
      seenIds.current.add(inserted.post_id);

      const arr = await fetchCountsSingle(inserted.post_id, false);
      setCountsMap(prev => ({ ...prev, [inserted.post_id]: arr ?? prev[inserted.post_id] ?? [] }));
      setCountsVersion(v => v + 1);
    } catch (e) {
      console.error(e);
      setErrMsg('投稿に失敗しました');
    }
  };

  const toInitialCounts = (pid: string): ReactionCount[] => countsMap[pid] || [];

  /* ===== Render ===== */
  return (
    <div className="thread-page">
      <div className="thread-topbar">
        <button className="back-btn" onClick={() => router.back()}>← 戻る</button>
      </div>

      <header className="thread-header">
        <img
          src={avatarSrcFrom(parent?.user_code)}
          alt="avatar"
          className="avatar"
          width={44}
          height={44}
          onClick={() => goProfile(parent?.user_code)}
          onError={onAvatarError}
        />
        <div className="header-info">
          <div className="header-title">
            <strong onClick={() => goProfile(parent?.user_code)}>
              {parent?.click_username || parent?.user_code || 'スレッド'}
            </strong>
            <small>{parent ? new Date(parent.created_at).toLocaleString('ja-JP') : ''}</small>
          </div>
          {parent?.content && <p className="header-text">{parent.content}</p>}
          {parent?.post_id && (
            <ReactionBar
              key={`parent-${parent.post_id}-${countsVersion}`}
              postId={parent.post_id}
              threadId={parent.thread_id ?? null}
              isParent={true}
              initialCounts={toCounts(toInitialCounts(parent.post_id))}
            />
          )}
        </div>
      </header>

      <main className="thread-scroll" ref={listRef}>
        {loading && <div className="meta">読み込み中...</div>}
        {errMsg && <div className="meta" style={{ color: '#ff9aa2' }}>{errMsg}</div>}
        {children.map(post => (
          <article key={post.post_id} className="post">
            <div className="author-line">
              <img
                className="avatar child"
                src={avatarSrcFrom(post.user_code)}
                alt="avatar"
                width={32}
                height={32}
                onClick={() => goProfile(post.user_code)}
                onError={onAvatarError}
              />
              <div className="author-meta">
                <strong onClick={() => goProfile(post.user_code)}>
                  {post.click_username || post.user_code || 'unknown'}
                </strong>
                <span>{new Date(post.created_at).toLocaleString('ja-JP')}</span>
              </div>
            </div>
            <div className="content">{post.content}</div>
            <ReactionBar
              key={`child-${post.post_id}-${countsVersion}`}
              postId={post.post_id}
              threadId={post.thread_id ?? null}
              isParent={false}
              initialCounts={toCounts(countsMap[post.post_id])}
            />
          </article>
        ))}
      </main>

      <footer className="post-form">
        <textarea
          value={newComment}
          onChange={e => setNewComment(e.target.value)}
          placeholder="コメントを入力..."
        />
        <button onClick={handlePost} disabled={!newComment.trim()}>送信</button>
      </footer>
    </div>
  );
}
