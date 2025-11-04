'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useRouter } from 'next/navigation';
import PostModal from '@/components/PostModal';
import './create.css';

type Post = {
  post_id: string;
  title?: string;
  content?: string;
  media_urls: string[]; // 例: "669933/xxx.png"
  tags?: string[];
  visibility?: string;
  created_at: string;
  board_type?: string;
};

export default function CreatePage() {
  const { userCode } = useAuth();
  const router = useRouter();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  // スクロール用
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasAutoScrolledRef = useRef(false); // 初回だけ自動スクロール

  // 画像ロード完了監視用
  const [imgTotal, setImgTotal] = useState(0);
  const [imgLoaded, setImgLoaded] = useState(0);

  // 投稿一覧取得
  const fetchPosts = async () => {
    if (!userCode) {
      console.warn('[投稿一覧取得失敗] user_codeが必要です');
      return;
    }

    try {
      const res = await fetch('/api/my-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: userCode }),
      });

      if (!res.ok) {
        console.error('[投稿一覧取得失敗] ステータス:', res.status);
        return;
      }

      const json = await res.json();
      const all: Post[] = Array.isArray(json) ? json : (json.posts ?? json.data ?? []);

      if (!Array.isArray(all)) {
        console.error('[my-posts] Unexpected response shape:', json);
        setPosts([]);
        return;
      }

      // アルバムの非公開のみ
      const filtered = all.filter((p) => p.visibility === 'private' && p.board_type === 'album');

      // 古い→新しい（最新が一番下）
      const sorted = filtered.sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );

      setPosts(sorted);

      // 画像の合計枚数をカウント（ロード待ちのため）
      const total = sorted.reduce(
        (acc, p) => acc + (Array.isArray(p.media_urls) ? p.media_urls.length : 0),
        0,
      );
      setImgTotal(total);
      setImgLoaded(0);
    } catch (err) {
      console.error('[投稿一覧取得失敗]', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (userCode) fetchPosts();
  }, [userCode]);

  // スクロール関数（冪等）
  const scrollToBottom = () => {
    // ref優先
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    // 念のためページ全体にもフォールバック
    try {
      const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      window.scrollTo({ top: h, behavior: 'smooth' });
    } catch {}
  };

  // 1) posts が描画キューに載った直後にスクロール（複数回呼んで確実に）
  useEffect(() => {
    if (!hasAutoScrolledRef.current && posts.length > 0) {
      // 次フレーム、その少し後、さらに少し後…と3回トライ
      requestAnimationFrame(() => scrollToBottom());
      setTimeout(scrollToBottom, 60);
      setTimeout(scrollToBottom, 300);
      // 画像待ちでもスクロールするので、ここではフラグを立てない
    }
  }, [posts]);

  // 2) 画像読み込みが全て完了したタイミングで最下部へ
  useEffect(() => {
    if (!hasAutoScrolledRef.current && imgTotal > 0 && imgLoaded >= imgTotal) {
      scrollToBottom();
      hasAutoScrolledRef.current = true; // 初回のみ
    } else if (!hasAutoScrolledRef.current && imgTotal === 0 && posts.length > 0) {
      // 画像ゼロのケースでも一度だけスクロール
      scrollToBottom();
      hasAutoScrolledRef.current = true;
    }
  }, [imgLoaded, imgTotal, posts.length]);

  // 画像 onLoad / onError ハンドラ
  const handleImgDone = () => setImgLoaded((n) => n + 1);

  const list = useMemo(() => posts, [posts]);

  return (
    <div className="create-page">
      <h2>あなたの投稿一覧</h2>

      {loading ? (
        <p>読み込み中...</p>
      ) : list.length === 0 ? (
        <p>まだ投稿がありません。</p>
      ) : (
        <ul className="post-list">
          {list.map((post) => (
            <li key={post.post_id} className="post-item">
              {post.title && <h3 className="post-title">{post.title}</h3>}

              {Array.isArray(post.media_urls) && post.media_urls.length > 0 ? (
                post.media_urls.map((path, i) => (
                  <img
                    key={i}
                    src={`/api/media?path=${encodeURIComponent(path)}`}
                    alt={`画像${i + 1}`}
                    className="post-image"
                    onLoad={handleImgDone}
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).src = '/no-image.png';
                      (e.currentTarget as HTMLImageElement).alt = '画像を読み込めませんでした';
                      handleImgDone();
                    }}
                  />
                ))
              ) : (
                <p>画像はありません</p>
              )}

              {post.content && <p className="post-content">{post.content}</p>}

              {post.tags?.length > 0 && (
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
        <button
          className="post-button"
          onClick={() => {
            hasAutoScrolledRef.current = false; // 新規投稿後も下まで行くように
            setModalOpen(true);
          }}
        >
          ＋ 投稿する
        </button>
        <button className="post-button-red" onClick={() => router.push('/album')}>
          📷 アルバムを見る
        </button>
      </div>

      {/* 最下部アンカー */}
      <div ref={bottomRef} style={{ height: 1 }} />

      <PostModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        userCode={userCode ?? ''}
        onPostSuccess={() => {
          hasAutoScrolledRef.current = false; // 再取得後にまた最下部へ
          fetchPosts();
        }}
        scrollTargetRef={bottomRef}
      />
    </div>
  );
}
