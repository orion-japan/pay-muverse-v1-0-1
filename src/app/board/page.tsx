'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useRouter } from 'next/navigation';
import QBoardPostModal from '@/components/QBoardPostModal';
import PostDetailModal from '@/components/PostDetailModal';
import { copyImageToPublic } from '@/lib/copyImageToPublic';
import './board.css';

type Post = {
  post_id: string;
  title?: string;
  content?: string;
  category?: string;
  tags?: string[];
  media_urls: string[];
  created_at: string;
};

export default function QBoardPage() {
  const { userCode } = useAuth();
  const router = useRouter();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [detailPost, setDetailPost] = useState<Post | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 投稿一覧取得
  const fetchPosts = async () => {
    if (!userCode) {
      console.warn('[QBoard] user_codeが必要です');
      return;
    }
    try {
      const res = await fetch('/api/qboard-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: userCode }),
      });
      if (!res.ok) {
        console.error('[QBoard] 投稿取得失敗', res.status);
        return;
      }
      const data = await res.json();
      const sorted = (data.posts || []).sort(
        (a: Post, b: Post) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      setPosts(sorted);

      // ✅ フィードを保持（戻ってきても消えない）
      sessionStorage.setItem('qboard_posts', JSON.stringify(sorted));
    } catch (err) {
      console.error('[QBoard] 投稿取得エラー', err);
    } finally {
      setLoading(false);
    }
  };

  // 初回：sessionStorage から復元 → なければ取得
  useEffect(() => {
    const saved = sessionStorage.getItem('qboard_posts');
    if (saved) {
      try {
        const parsed: Post[] = JSON.parse(saved);
        setPosts(parsed);
        setLoading(false);
      } catch {
        // 破損時は無視して取得へ
        fetchPosts();
      }
    } else {
      fetchPosts();
    }
  }, [userCode]);

  return (
    <div className="qboard-page">
      <h2>Qボード 投稿一覧</h2>

      {loading ? (
        <p>読み込み中...</p>
      ) : posts.length === 0 ? (
        <p>まだ投稿がありません。</p>
      ) : (
        <ul className="qboard-post-list">
          {posts.map((post) => (
            <li key={post.post_id} className="qboard-post-item">
              {post.media_urls?.length > 0 && (
                <img
                  src={post.media_urls[0]}
                  alt={post.title || '投稿画像'}
                  className="qboard-post-image"
                  onClick={() => setDetailPost(post)}
                />
              )}
              {post.title && <h3 className="qboard-post-title">{post.title}</h3>}
            </li>
          ))}
        </ul>
      )}

      {/* Qボタン（押したらアルバムへ） */}
      <div className="qboard-buttons">
        <button
          className="qboard-button"
          onClick={() => router.push('/album')} // ← ここだけ動作変更
        >
          ＋ Qボード投稿
        </button>
      </div>

      {/* 投稿モーダル（構造維持のため残置、必要ならmodalOpenをtrueにして使えます） */}
      <QBoardPostModal
        posts={posts}
        userCode={userCode ?? ''}
        onClose={() => setModalOpen(false)}
        onPosted={fetchPosts}
      />

      {/* 詳細モーダル */}
      {detailPost && (
        <PostDetailModal
          post={detailPost}
          onClose={() => setDetailPost(null)}
        />
      )}

      {/* スクロールターゲット */}
      <div ref={bottomRef} style={{ height: '1px' }} />
    </div>
  );
}
