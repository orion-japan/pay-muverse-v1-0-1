'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useRouter } from 'next/navigation';
import PostModal from '@/components/PostModal';
import './create.css';

type Post = {
  post_id: string;
  title?: string;
  content?: string;
  media_urls: string[];
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
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  // 署名付きURL取得
  const fetchSignedUrls = async (posts: Post[]) => {
    const urlMap: Record<string, string> = {};
    for (const p of posts) {
      for (const path of p.media_urls || []) {
        try {
          const res = await fetch(`/api/media?path=${encodeURIComponent(path)}`);
          if (res.ok) {
            const { signedUrl } = await res.json();
            urlMap[path] = signedUrl;
          }
        } catch (e) {
          console.error('[fetchSignedUrls] error', e);
        }
      }
    }
    setSignedUrls(urlMap);
  };

  // 投稿一覧取得
  const fetchPosts = async () => {
    if (!userCode) {
      console.warn('[投稿一覧取得失敗] user_codeが必要です');
      return;
    }
    try {
      const res = await fetch(`/api/i-posts?userCode=${encodeURIComponent(userCode)}`);
      if (!res.ok) {
        console.error('[投稿一覧取得失敗] ステータス:', res.status);
        return;
      }
      const data = await res.json();
      const privatePosts = (data || []).filter((post: Post) => post.visibility === 'private');
      const sorted = privatePosts.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      setPosts(sorted);
      fetchSignedUrls(sorted);
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

              {post.media_urls?.map((path, i) => {
                const url = signedUrls[path];
                return url ? (
                  <img key={i} src={url} alt={`画像${i + 1}`} className="post-image" />
                ) : (
                  <p key={i}>画像取得中...</p>
                );
              })}

              {post.content && <p className="post-content">{post.content}</p>}

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

      <PostModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        userCode={userCode ?? ''}
        onPostSuccess={fetchPosts}
        scrollTargetRef={bottomRef}
      />

      <div ref={bottomRef} style={{ height: '1px' }} />
    </div>
  );
}
