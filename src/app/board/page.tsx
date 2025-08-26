'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import './board.css';

// ★ コラージュ作成ページのパス（あなたの実装に合わせて変更OK）
const COLLAGE_PATH = '/collage';

// ───────────────────── 追加：軽量スライダー（CSSスクロールスナップ） ─────────────────────
function MediaSlider({ href, urls }: { href: string; urls: string[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);

  const slideBy = (dir: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const w = el.clientWidth;
    el.scrollBy({ left: dir * w, behavior: 'smooth' });
  };

  if (!urls || urls.length === 0) return null;

  // 1枚だけなら従来どおり
  if (urls.length === 1) {
    return (
      <Link href={href} className="image-link">
        <img src={urls[0]} alt="image-0" className="post-image" loading="lazy" />
      </Link>
    );
  }

  return (
    <div className="list-slider">
      <div className="list-slider-wrap" ref={wrapRef}>
        {urls.map((src, i) => (
          <Link key={i} href={href} className="list-slide">
            <img src={src} alt={`image-${i}`} loading="lazy" />
          </Link>
        ))}
      </div>
      <button className="list-nav prev" onClick={() => slideBy(-1)} aria-label="前へ">‹</button>
      <button className="list-nav next" onClick={() => slideBy(1)} aria-label="次へ">›</button>
    </div>
  );
}
// ───────────────────────────────────────────────────────────────────────────────

type Post = {
  post_id: string;
  title?: string;
  content?: string;
  category?: string;
  tags?: string[];
  media_urls: any[]; // string[] or { url: string }[]
  visibility?: string;
  created_at: string;
  board_type?: string;
  likes_count?: number | null;
  comments_count?: number | null;
  q_code?: { resonance?: { likes?: number; comments?: number } } | null;
};

type SortKey = 'new' | 'old' | 'title';

export default function BoardPage() {
  const router = useRouter();
  const [allPosts, setAllPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // UI 状態
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('new');
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<string>('すべて');
  const [pageCount, setPageCount] = useState(1); // 「もっと見る」
  const PAGE_SIZE = 12;
  const bottomRef = useRef<HTMLDivElement>(null);

  const likeCount = (p: Post) =>
    p.likes_count ?? p.q_code?.resonance?.likes ?? 0;
  const commentCount = (p: Post) =>
    p.comments_count ?? p.q_code?.resonance?.comments ?? 0;

  const fetchPublicPosts = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/iboard-posts?board=iboard', { method: 'GET' });
      if (!res.ok) {
        setErrorMsg(`取得失敗: ${res.status}`);
        setAllPosts([]);
        return;
      }
      const body = await res.json();
      const data: Post[] = Array.isArray(body) ? body : body.posts || [];

      const filtered = (data || []).filter((post) => {
        if (post.visibility !== 'public') return false;
        if (!Array.isArray(post.media_urls)) return false;
        return post.media_urls.every((u: any) => {
          const url = typeof u === 'string' ? u : u?.url || '';
          return url && !url.includes('/private-posts/');
        });
      });

      setAllPosts(filtered);
    } catch (err: any) {
      console.error('[Board] fetch error:', err);
      setErrorMsg('ネットワークエラー');
      setAllPosts([]);
    } finally {
      setLoading(false);
      setPageCount(1);
    }
  };

  useEffect(() => {
    fetchPublicPosts();
  }, []);

  // ♻️ 30秒ポーリング
  useEffect(() => {
    const id = setInterval(fetchPublicPosts, 30_000);
    return () => clearInterval(id);
  }, []);

  // タグ候補（投稿から抽出）
  const tagPool = useMemo(() => {
    const set = new Set<string>();
    allPosts.forEach((p) => (p.tags || []).forEach((t) => t && set.add(t)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allPosts]);

  // カテゴリ候補（投稿から抽出）
  const categoryPool = useMemo(() => {
    const set = new Set<string>();
    allPosts.forEach((p) => p.category && set.add(p.category));
    return ['すべて', ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [allPosts]);

  const toggleTag = (tag: string) => {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
    setPageCount(1);
  };

  const visiblePosts = useMemo(() => {
    let list = [...allPosts];

    // 検索
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((p) =>
        [p.title, p.content, ...(p.tags || [])].join(' ').toLowerCase().includes(q)
      );
    }

    // カテゴリ
    if (category !== 'すべて') {
      list = list.filter((p) => (p.category || '') === category);
    }

    // タグ（AND）
    if (activeTags.size > 0) {
      list = list.filter((p) => {
        const t = new Set(p.tags || []);
        for (const need of activeTags) if (!t.has(need)) return false;
        return true;
      });
    }

    // 並び替え
    list.sort((a, b) => {
      if (sort === 'new') return +new Date(b.created_at) - +new Date(a.created_at);
      if (sort === 'old') return +new Date(a.created_at) - +new Date(b.created_at);
      return (a.title || '').localeCompare(b.title || '');
    });

    return list;
  }, [allPosts, search, category, activeTags, sort]);

  const paged = useMemo(
    () => visiblePosts.slice(0, PAGE_SIZE * pageCount),
    [visiblePosts, pageCount]
  );

  // ✅ 下部アクションバー用：もっと見る可否
  const hasMore = useMemo(
    () => paged.length < visiblePosts.length,
    [paged.length, visiblePosts.length]
  );

  return (
    <div className="qboard-page">
      <h2>🌐 Iボード（公開フィード）</h2>

      {/* コントロールバー */}
      <div className="board-controls" style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            placeholder="検索（タイトル・本文・タグ）"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPageCount(1); }}
            style={{ flex: 1 }}
          />
          <select value={category} onChange={(e) => { setCategory(e.target.value); setPageCount(1); }}>
            {categoryPool.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} title="並び替え">
            <option value="new">新しい順</option>
            <option value="old">古い順</option>
            <option value="title">タイトル順</option>
          </select>
          <button onClick={fetchPublicPosts} aria-label="再読込">再読込</button>
        </div>

        {/* タグフィルタ */}
        {tagPool.length > 0 && (
          <div className="tag-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {tagPool.map((tag) => {
              const active = activeTags.has(tag);
              return (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={`tag-chip ${active ? 'active' : ''}`}
                  style={{
                    padding: '4px 10px', borderRadius: 14, border: '1px solid #ddd',
                    background: active ? '#7b5cff' : '#fff', color: active ? '#fff' : '#333',
                    cursor: 'pointer',
                  }}
                  aria-pressed={active}
                >
                  #{tag}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {loading ? (
        <p>読み込み中...</p>
      ) : errorMsg ? (
        <p style={{ color: 'crimson' }}>{errorMsg}</p>
      ) : paged.length === 0 ? (
        <p>該当する公開投稿がありません。</p>
      ) : (
        <>
          {/* 🧱 Masonry（CSS columns 方式） */}
          <div className="masonry">
            {paged.map((post) => {
              const urls: string[] = Array.isArray(post.media_urls)
                ? post.media_urls
                    .map((u: any) => (typeof u === 'string' ? u : u?.url))
                    .filter(Boolean)
                : [];

              return (
                <article key={post.post_id} className="post-item post-card" role="group">
                  {/* 🔗 パーマリンク（カード右上） */}
                  <div className="post-permalink">
                    <Link
                      href={`/board/${post.post_id}`}
                      aria-label="パーマリンクで開く"
                      title="パーマリンクで開く"
                    >
                      ↗︎
                    </Link>
                  </div>

                  {/* タイトル：クリックで詳細へ */}
                  {post.title && (
                    <h3 className="post-title">
                      <Link href={`/board/${post.post_id}`} className="title-link">
                        {post.title}
                      </Link>
                    </h3>
                  )}

                  {/* 画像：複数ならスライダー、1枚なら従来表示 */}
                  <MediaSlider href={`/board/${post.post_id}`} urls={urls} />

                  {post.content && <p className="post-content">{post.content}</p>}

                  {/* 💬 コメント/いいね カウント */}
                  <div className="post-meta">
                    <span>❤️ {likeCount(post)}</span>
                    <Link
                      href={`/board/${post.post_id}?focus=comments`}
                      className="meta-link"
                      title="コメントを見る"
                      aria-label="コメントを見る"
                    >
                      💬 {commentCount(post)}
                    </Link>
                    <span>📅 {new Date(post.created_at).toLocaleDateString()}</span>
                  </div>

                  {post.tags && post.tags.length > 0 && (
                    <div className="tags">
                      {post.tags.map((tag, i) => (
                        <span key={i} className="tag">#{tag}</span>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>

          {/* もっと見る */}
          {paged.length < visiblePosts.length && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
              <button type="button" onClick={() => setPageCount((n) => n + 1)}>もっと見る</button>
            </div>
          )}
        </>
      )}

      {/* 投稿動線（上の赤ボタン） */}
      <div className="post-buttons">
        <button
          type="button"
          className="post-button-red"
          onClick={() => router.push(COLLAGE_PATH)}
          aria-label="コラージュを作る"
          title="コラージュを作る"
        >
          ＋ コラージュを作る
        </button>
      </div>

      {/* ✅ 下部アクションバー（sticky） */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: 'rgba(255,255,255,0.96)',
          borderTop: '1px solid #eee',
          padding: 12,
          backdropFilter: 'blur(6px)',
          marginTop: 12,
          zIndex: 1000,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
            maxWidth: 1280,
            margin: '0 auto',
          }}
        >
          <span style={{ color: '#666', fontSize: 14 }}>📎 下から操作できます</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {hasMore && (
              <button type="button" onClick={() => setPageCount((n) => n + 1)}>
                もっと見る
              </button>
            )}
            <button type="button" onClick={fetchPublicPosts} aria-label="最新を読み込む">
              最新を読み込む
            </button>
            <button
              type="button"
              className="post-button-red"
              onClick={() => router.push(COLLAGE_PATH)}
              aria-label="コラージュを作る"
              title="コラージュを作る"
            >
              ＋ コラージュを作る
            </button>
          </div>
        </div>
      </div>

      <div ref={bottomRef} style={{ height: '1px' }} />
    </div>
  );
}
