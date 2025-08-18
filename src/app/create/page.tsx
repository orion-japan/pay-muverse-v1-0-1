'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useRouter } from 'next/navigation';
import PostModal from '@/components/PostModal'; // ✅ 正しい場所にPostModalがある前提
import './create.css';

type Post = {
  post_id: string;
  title?: string;
  content?: string;
  media_urls: any[]; // string[] または { url: string }[]
  tags?: string[];
  visibility?: string;
  created_at: string;
};

export default function CreatePage() {
  const { userCode } = useAuth();
  const router = useRouter();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null); // ✅ スクロールターゲット

  // 投稿一覧取得（/api/i-posts）
  const fetchPosts = async () => {
    if (!userCode) {
      console.warn('[投稿一覧取得失敗] user_codeが必要です');
      return;
    }

    console.log('[投稿一覧] user_code:', userCode);

    try {
      const res = await fetch(`/api/i-posts?userCode=${encodeURIComponent(userCode)}`, {
        method: 'GET',
      });

      if (!res.ok) {
        console.error('[投稿一覧取得失敗] ステータス:', res.status);
        return;
      }

      const data = await res.json();
      console.log('[投稿一覧取得成功]', data);

      // ✅ visibility === 'private' のみ抽出
      const privatePosts = (data || []).filter(
        (post: Post) => post.visibility === 'private'
      );

      // ✅ 最新順に並べ替え
      setPosts(
        privatePosts.sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )
      );
    } catch (err) {
      console.error('[投稿一覧取得失敗]', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPosts();
  }, [userCode]);

  return (
    <div className="create-page">
      <h2>あなたの投稿一覧</h2>

      {loading ? (
        <p>読み込み中...</p>
      ) : posts.length === 0 ? (
        <p>まだ投稿がありません。</p>
      ) : (
        <ul className="post-list">
          {posts.map((post) => (
            <li key={post.post_id} className="post-item">
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

      {/* 投稿・アルバムボタン */}
      <div className="post-buttons">
        <button className="post-button" onClick={() => setModalOpen(true)}>
          ＋ 投稿する
        </button>
        <button
          className="post-button-red"
          onClick={() => router.push('/album')}
        >
          📷 アルバムを見る
        </button>
      </div>

      {/* 投稿モーダル（/api/i-posts に保存する） */}
      <PostModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        userCode={userCode ?? ''}
        onPostSuccess={fetchPosts}
        scrollTargetRef={bottomRef}
      />

      {/* ⬇ スクロール対象 */}
      <div ref={bottomRef} style={{ height: '1px' }} />
    </div>
  );
}
