'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import SelfPostModal from '@/components/SelfPostModal';
import './self.css';

type Post = {
  post_id: string;
  title?: string;
  content?: string;
  tags?: string[];
  media_urls: string[];
  created_at: string;
  board_type?: string | null;
};

const BOARD_TYPE = 'self';

export default function SelfPage() {
  const { userCode } = useAuth();
  const router = useRouter();

  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  const fetchSelfPosts = async (code: string) => {
    const url = `/api/self-posts?userCode=${encodeURIComponent(
      code
    )}&boardType=${encodeURIComponent(BOARD_TYPE)}`;

    console.log('[SelfPage] 📡 取得開始', { url, BOARD_TYPE });

    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('[SelfPage] ❌ API失敗', res.status, t);
      setPosts([]);
      return;
    }
    const data: Post[] = await res.json();
    console.log('[SelfPage] ✅ 取得成功（件数）', data?.length ?? 0);

    // 念のためフロントでも self だけ残す
    const filtered = Array.isArray(data)
      ? data.filter((p) => (p as any)?.board_type === BOARD_TYPE)
      : [];
    if (filtered.length !== (data?.length ?? 0)) {
      console.warn('[SelfPage] ⚠️ self以外を除外', {
        returned: data?.length ?? 0,
        kept: filtered.length,
      });
    }
    setPosts(filtered);
  };

  useEffect(() => {
    if (!userCode) return;
    setLoading(true);
    fetchSelfPosts(userCode).finally(() => setLoading(false));
  }, [userCode]);

  const openPostModal = () => setModalOpen(true);
  const closePostModal = () => setModalOpen(false);

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });

  return (
    <div className="self-page">
      <h1>🧠 今の声</h1>

      {loading ? (
        <p>読み込み中...</p>
      ) : (
        <section className="post-feed">
          {posts.map((post) => (
            <div
              className="thread-card"
              key={post.post_id}
              onClick={() => router.push(`/board/${post.post_id}`)}
            >
              {post.media_urls?.[0] && (
                <img src={post.media_urls[0]} alt="thumb" className="thumb" />
              )}
              <div className="text-block">
                <h3>{post.title || '（タイトルなし）'}</h3>
                <p>{(post.content || '').slice(0, 80)}...</p>
                <div className="meta">
                  <span>{formatDate(post.created_at)}</span>
                  <span className="tags">
                    {post.tags?.map((tag) => `#${tag}`).join(' ')}
                  </span>
                </div>
              </div>
            </div>
          ))}
          {!posts.length && <p>selfの投稿はまだありません。</p>}
        </section>
      )}

      <button className="floating-button" onClick={openPostModal}>＋R</button>

      <SelfPostModal
        isOpen={modalOpen}
        onClose={closePostModal}
        userCode={userCode || ''}
        boardType={BOARD_TYPE}
        onPostSuccess={() => {
          console.log('[SelfPage] 🔄 投稿後の再取得トリガ');
          if (!userCode) return;
          setLoading(true);
          fetchSelfPosts(userCode).finally(() => setLoading(false));
        }}
      />
    </div>
  );
}
