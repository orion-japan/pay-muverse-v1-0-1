'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import AlbumCard from '@/components/AlbumCard';
import PostDetailModal from '@/components/PostDetailModal';
import './album.css';

export default function AlbumPage() {
  const { userCode } = useAuth();
  const [posts, setPosts] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'new' | 'old' | 'title'>('new');
  const [selectedPost, setSelectedPost] = useState<any>(null);

  const fetchPosts = async () => {
    if (!userCode) return;
    const res = await fetch('/api/my-posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_code: userCode }),
    });
    const data = await res.json();
    if (data.posts) setPosts(data.posts);
  };

  useEffect(() => {
    fetchPosts();
  }, [userCode]);

  const filtered = posts
    .filter((p) =>
      [p.title, p.category, p.content, ...(p.tags || [])]
        .join(' ')
        .toLowerCase()
        .includes(search.toLowerCase())
    )
    .sort((a, b) => {
      if (sort === 'new')
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (sort === 'old')
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return (a.title || '').localeCompare(b.title || '');
    });

  return (
    <div className="album-page">
      <h2>あなたのアルバム</h2>

      <div className="album-controls">
        <input
          type="text"
          placeholder="検索..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as any)}>
          <option value="new">新しい順</option>
          <option value="old">古い順</option>
          <option value="title">タイトル順</option>
        </select>
      </div>

      <div className="album-grid">
        {filtered.map((post) => (
          <AlbumCard
            key={post.post_id}
            post={post}
            onClick={() => setSelectedPost(post)}
          />
        ))}
      </div>

      {selectedPost && (
        <PostDetailModal
          post={selectedPost}
          onClose={() => setSelectedPost(null)}
          onUpdated={fetchPosts}
        />
      )}
    </div>
  );
}
