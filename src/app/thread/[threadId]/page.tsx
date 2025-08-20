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
  click_username?: string | null; // 表示名をここに格納
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

  // user_code -> avatar_url（profiles で拾えたものをキャッシュ）
  const [avatarMap, setAvatarMap] = useState<Record<string, string>>({});

  // リスト自動スクロール
  const listRef = useRef<HTMLDivElement | null>(null);

  // 重複挿入ガード（投稿即時追加＋Realtime二重到着を抑止）
  const seenIds = useRef<Set<string>>(new Set());

  /* ===== Helpers ===== */
  // ReactionBar 用に配列 -> カウントオブジェクトへ変換
  type CountsLike = Partial<{ like: number; heart: number; smile: number; wow: number; share: number }>;
  const toCounts = (arr?: ReactionCount[] | null): CountsLike => {
    const out: CountsLike = {};
    if (!arr) return out;
    const allow = new Set(['like', 'heart', 'smile', 'wow', 'share']);
    for (const a of arr) {
      const k = String(a?.r_type || '').toLowerCase();
      if (allow.has(k)) (out as any)[k] = a?.count ?? 0;
    }
    return out;
  };
  // user_code → アバターURL（profiles で拾えたら優先、無ければ /api/avatar/:code）
  const avatarSrcFrom = (code?: string | null) => {
    if (!code) return DEFAULT_AVATAR;
    // profiles で拾えたら優先（あるなら使う）
    // if (avatarMap[code]) return avatarMap[code];
    // 既定は /api/avatar/:code
    return `/api/avatar/${encodeURIComponent(code)}`;
  };

  // 画像404時のフォールバック（1回だけ）
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

  /** profiles(name, avatar_url) から一括補完 */
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
      p.user_code
        ? { ...p, click_username: nameMap.get(p.user_code) ?? p.click_username ?? p.user_code }
        : p
    );
  }

  /** 反応カウント（API → 失敗時はpost_reactionsからフォールバック集計） */
  async function fetchCountsBulk(ids: string[]) {
    if (!ids.length) {
      setCountsMap({});
      return;
    }
    try {
      const res = await fetch('/api/reactions/counts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postIds: ids }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { countsByPost } = await res.json();
      setCountsMap(countsByPost || {});
    } catch {
      try {
        const { data, error } = await supabase
          .from('post_reactions')
          .select('post_id,type')
          .in('post_id', ids);
        if (error) throw error;

        const tmp: Record<string, Record<string, number>> = {};
        (data || []).forEach((r: any) => {
          const pid = String(r.post_id);
          const t = String(r.type);
          tmp[pid] ??= {};
          tmp[pid][t] = (tmp[pid][t] || 0) + 1;
        });
        const packed: Record<string, ReactionCount[]> = {};
        Object.entries(tmp).forEach(([pid, m]) => {
          packed[pid] = Object.entries(m).map(([r_type, count]) => ({ r_type, count }));
        });
        setCountsMap(packed);
      } catch (e) {
        console.warn('[Thread] fallback counts error', e);
        setCountsMap({});
      }
    }
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

        // 子（昇順）
        const { data: cRows, error: cErr } = await supabase
          .from('posts')
          .select('post_id,user_code,content,created_at,media_urls,is_posted,thread_id')
          .eq('thread_id', threadId)
          .order('created_at', { ascending: true });
        if (cErr) throw cErr;

        const [hydratedParent] = await hydrateFromProfiles([pRow as Post]);
        const hydratedChildren = await hydrateFromProfiles((cRows || []) as Post[]);
        if (!mounted) return;

        setParent(hydratedParent);
        setChildren(hydratedChildren);

        const ids = [hydratedParent.post_id, ...hydratedChildren.map(p => p.post_id)];
        await fetchCountsBulk(ids);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  /* ===== Realtime ===== */
  useEffect(() => {
    if (!threadId) return;

    // 子投稿の変化
    const chPosts = supabase
      .channel(`thread_posts_${threadId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'posts', filter: `thread_id=eq.${threadId}` },
        async payload => {
          if (payload.eventType === 'INSERT') {
            const row = payload.new as Post;
            if (seenIds.current.has(row.post_id)) return; // 重複ガード
            const [hydrated] = await hydrateFromProfiles([row]);
            setChildren(prev =>
              prev.some(p => p.post_id === row.post_id) ? prev : [...prev, hydrated]
            );
            seenIds.current.add(row.post_id);
            fetchCountsBulk([row.post_id]);
          } else if (payload.eventType === 'UPDATE') {
            const row = payload.new as Post;
            const [hydrated] = await hydrateFromProfiles([row]);
            setChildren(prev => prev.map(p => (p.post_id === row.post_id ? hydrated : p)));
          } else if (payload.eventType === 'DELETE') {
            const row = payload.old as Post;
            setChildren(prev => prev.filter(p => p.post_id !== (row as any).post_id));
          }
        }
      )
      .subscribe(() => console.log('[ThreadPage] Realtime (posts) subscribed'));

    // 親のリアクション
    const chReactParent = supabase
      .channel(`reactions_parent_${threadId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'post_reactions', filter: `post_id=eq.${threadId}` },
        async () => {
          await fetchCountsBulk([String(threadId)]);
        }
      )
      .subscribe(() => console.log('[ThreadPage] Realtime (reactions parent) subscribed'));

    // スレッド全体のリアクション
    const chReactThread = supabase
      .channel(`reactions_thread_${threadId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'post_reactions', filter: `thread_id=eq.${threadId}` },
        async payload => {
          const changed = (payload.new as any)?.post_id || (payload.old as any)?.post_id;
          if (changed) await fetchCountsBulk([changed]);
        }
      )
      .subscribe(() => console.log('[ThreadPage] Realtime (reactions thread) subscribed'));

    return () => {
      supabase.removeChannel(chPosts);
      supabase.removeChannel(chReactParent);
      supabase.removeChannel(chReactThread);
    };
  }, [threadId]);

  /* ===== Auto scroll to bottom on change ===== */
  useEffect(() => {
    if (!listRef.current) return;
    const t = setTimeout(() => {
      listRef.current!.scrollTop = listRef.current!.scrollHeight;
    }, 40);
    return () => clearTimeout(t);
  }, [children.length]);

  /* ===== Qコード記録だけ（存在しなければ無視） ===== */
  useEffect(() => {
    if (!parent?.user_code) return;
    fetch(`/api/qcode/${encodeURIComponent(parent.user_code)}/get`).catch(() => {});
  }, [parent?.user_code]);

  /* ===== 投稿（Service Route 経由 /api/thread/comment） ===== */
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
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`POST /api/thread/comment ${res.status} ${t}`);
      }

      const inserted = (await res.json()) as Post;
      setNewComment('');

      const [hydrated] = await hydrateFromProfiles([inserted]);
      setChildren(prev =>
        prev.some(p => p.post_id === inserted.post_id) ? prev : [...prev, hydrated]
      );
      seenIds.current.add(inserted.post_id);
    } catch (e) {
      console.error('[ThreadPage] handlePost error', e);
      setErrMsg('投稿に失敗しました');
    }
  };

  const toInitialCounts = (pid: string): ReactionCount[] => countsMap[pid] || [];

  /* ===== Render ===== */
  return (
    <div className="thread-page">
      {/* 上部・戻るボタン */}
      <div className="thread-topbar">
        <button className="back-btn" onClick={() => router.back()} aria-label="戻る">
          ← 戻る
        </button>
      </div>

      {/* 親ヘッダー（親BOX内にいいね群） */}
      <header className="thread-header">
        <img
          src={avatarSrcFrom(parent?.user_code)}
          alt="avatar"
          className="avatar"
          width={44}
          height={44}
          onClick={() => goProfile(parent?.user_code)}
          style={{ cursor: parent?.user_code ? 'pointer' : 'default' }}
          onError={onAvatarError}
        />
        <div className="header-info">
          <div className="header-title">
            <strong
              style={{ cursor: parent?.user_code ? 'pointer' : 'default' }}
              onClick={() => goProfile(parent?.user_code)}
            >
              {parent?.click_username || parent?.user_code || 'スレッド'}
            </strong>
            <small>{parent ? new Date(parent.created_at).toLocaleString('ja-JP') : ''}</small>
          </div>
          {parent?.content ? <p className="header-text">{parent.content}</p> : null}

          {parent?.post_id ? (
            <div className="parent-like-box">
              <ReactionBar
                postId={parent.post_id}
                threadId={parent.thread_id ?? null}
                isParent={true}
                initialCounts={toCounts(toInitialCounts(parent.post_id))}
              />
            </div>
          ) : null}
        </div>
      </header>

        {/* 子コメント */}
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
                style={{ cursor: post.user_code ? 'pointer' : 'default' }}
                onClick={() => goProfile(post.user_code)}
                onError={onAvatarError}
              />
              <div className="author-meta">
                <strong
                  style={{ cursor: post.user_code ? 'pointer' : 'default' }}
                  onClick={() => goProfile(post.user_code)}
                >
                  {post.click_username || post.user_code || 'unknown'}
                </strong>
                <span>{new Date(post.created_at).toLocaleString('ja-JP')}</span>
              </div>
            </div>

            <div className="content">{post.content}</div>
            <div className="reaction-row comment">
              <ReactionBar
                postId={post.post_id}
                threadId={post.thread_id ?? null}
                initialCounts={toCounts(countsMap[post.post_id])}
              />
            </div>
          </article>
        ))}
      </main>

      {/* 入力ボックス */}
      <footer className="post-form">
        <textarea
          value={newComment}
          onChange={e => setNewComment(e.target.value)}
          placeholder="コメントを入力..."
        />
        <button onClick={handlePost} disabled={!newComment.trim()}>
          送信
        </button>
      </footer>
    </div>
  );
}
