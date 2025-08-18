'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import './self.css';

type Profile = {
  user_code: string;
  name: string;
  avatar_url?: string | null;
};

type Post = {
  post_id: string;
  content?: string;
  created_at: string;
};

export default function SelfPage() {
  const { code } = useParams();
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  // プロフィール取得
  useEffect(() => {
    if (!code) return;
    fetch(`/api/get-profile?code=${encodeURIComponent(code as string)}`)
      .then(r => r.ok ? r.json() : null)
      .then(p => setProfile(p));
  }, [code]);

  // Self投稿取得
  useEffect(() => {
    if (!code) return;
    setLoading(true);
    fetch(`/api/self-posts?userCode=${encodeURIComponent(code as string)}&boardType=self`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : [])
      .then(data => setPosts(data))
      .finally(() => setLoading(false));
  }, [code]);

  return (
    <div className="self-page">
      {profile && (
        <div 
          className="user-header"
          onClick={() => router.push(`/profile/${profile.user_code}`)}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}
        >
          <img 
            src={profile.avatar_url || '/default.png'} 
            alt="avatar" 
            width={60} 
            height={60} 
            style={{ borderRadius: '50%' }} 
          />
          <div>
            <h2>{profile.name}</h2>
            <p style={{ fontSize: '0.9em', color: '#666' }}>👉 プロフィールを見る</p>
          </div>
        </div>
      )}

      <h3>🧠 Self 投稿一覧</h3>
      {loading ? (
        <p>読み込み中...</p>
      ) : posts.length === 0 ? (
        <p>まだ投稿がありません</p>
      ) : (
        <ul>
          {posts.map(p => (
            <li key={p.post_id}>
              <p>{p.content}</p>
              <small>{new Date(p.created_at).toLocaleString()}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
