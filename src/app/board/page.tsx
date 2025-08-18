'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useRouter } from 'next/navigation';
import PostDetailModal from '@/components/PostDetailModal';
import './board.css';

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
};

export default function QBoardPage() {
  const { userCode } = useAuth();
  const router = useRouter();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailPost, setDetailPost] = useState<Post | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchPosts = async () => {
    if (!userCode) {
      console.warn('[QBoard] user_codeが必要です');
      return;
    }

    console.log('[QBoard] user_code:', userCode);

    try {
      // ✅ /api/i-posts に繋ぎ替え（GET）
      const res = await fetch(`/api/i-posts?userCode=${encodeURIComponent(userCode)}`, {
        method: 'GET',
      });

      if (!res.ok) {
        console.error('[QBoard] 投稿取得失敗 ステータス:', res.status);
        return;
      }

      const data = await res.json();
      console.log('[QBoard] 投稿取得成功:', data);

      // ✅ 公開用の投稿だけ抽出
      const publicPosts = (data || []).filter(
        (post: Post) =>
          post.visibility === 'public' &&
          post.board_type === 'default' &&
          Array.isArray(post.media_urls) &&
          post.media_urls.every((url: any) => {
            const path = typeof url === 'string' ? url : url?.url || '';
            return !path.includes('/private-posts/');
          })
      );

      // ✅ 新しい順に並べ替え
      const sorted = publicPosts.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      setPosts(sorted);
    } catch (err) {
      console.error('[QBoard] 投稿取得失敗', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPosts();
  }, [userCode]);

  return (
    <div className="qboard-page">
      <h2>🌐 Qボード</h2>

      {loading ? (
        <p>読み込み中...</p>
      ) : posts.length === 0 ? (
        <p>まだ投稿がありません。</p>
      ) : (
        <ul className="post-list">
          {posts.map((post) => (
            <li
              key={post.post_id}
              className="post-item"
              onClick={() => setDetailPost(post)}
            >
              {post.title && <h3 className="post-title">{post.title}</h3>}

              {post.media_urls?.map((item, i) => {
                const url = typeof item === 'string' ? item : item?.url;
                return (
                  <img
                    key={i}
                    src={url}
                    alt={`画像${i + 1}`}
                    className="post-image"
                  />
                );
              })}

              {post.content && (
                <p className="post-content">{post.content}</p>
              )}

              {post.tags && post.tags.length > 0 && (
                <div className="tags">
                  {post.tags.map((tag, i) => (
                    <span key={i} className="tag">
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* 📷 アルバム投稿へ */}
      <div className="post-buttons">
        <button
          className="post-button-red"
          onClick={() => router.push('/album')}
        >
          ＋ Qボードに投稿する
        </button>
      </div>

      {/* 詳細モーダル */}
      {detailPost && (
        <PostDetailModal
          post={detailPost}
          onClose={() => setDetailPost(null)}
        />
      )}

      <div ref={bottomRef} style={{ height: '1px' }} />
    </div>
  );
}
