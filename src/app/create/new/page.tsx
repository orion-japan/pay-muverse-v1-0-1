'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/firebase'; // Firebase初期化済みauth
import PostModal from '@/components/PostModal';

type Post = {
  post_id: string;
  content: string;
  media_urls: string[];
  tags: string[];
  created_at: string;
};

export default function CreatePage() {
  const [userCode, setUserCode] = useState<string | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const router = useRouter();

  // 🔐 user_code取得
  useEffect(() => {
    const fetchUserCode = async () => {
      try {
        const user = auth.currentUser;
        if (!user) {
          console.warn('[投稿画面] Firebase未ログイン → /loginへ');
          router.push('/login');
          return;
        }

        const idToken = await user.getIdToken(true);
        const res = await fetch('/api/get-current-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        });

        if (!res.ok) throw new Error(`APIエラー: ${res.status}`);
        const data = await res.json();
        if (!data.user_code) throw new Error('user_codeが存在しません');

        console.log('[投稿画面] ✅ user_code取得:', data.user_code);
        setUserCode(data.user_code);
      } catch (err) {
        console.error('[投稿画面] ❌ user_code取得失敗', err);
      }
    };

    fetchUserCode();
  }, []);

  // 📰 投稿フィード取得
  useEffect(() => {
    if (!userCode) return;
    const fetchPosts = async () => {
      try {
        const res = await fetch(`/api/my-posts?code=${userCode}`);
        const data = await res.json();
        console.log('[投稿画面] ✅ 投稿取得:', data);
        setPosts(data);
      } catch (err) {
        console.error('[投稿画面] ❌ 投稿取得失敗', err);
      }
    };

    fetchPosts();
  }, [userCode]);

  return (
    <div className="create-page">
      <h1>投稿ページ</h1>
      <button onClick={() => setModalOpen(true)}>＋ 新規投稿</button>

      <PostModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        userCode={userCode ?? ''}
        onPostSuccess={() => {
          setModalOpen(false);
          // 再取得
          if (userCode) {
            fetch(`/api/my-posts?code=${userCode}`)
              .then(res => res.json())
              .then(data => setPosts(data));
          }
        }}
      />

      <div className="post-feed">
        {posts.map(post => (
          <div key={post.post_id} className="post">
            <p>{post.content}</p>
            {post.media_urls?.map((url, i) => (
              <img key={i} src={url} alt={`投稿画像${i + 1}`} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
