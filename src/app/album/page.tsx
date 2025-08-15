'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import AlbumCard from '@/components/AlbumCard';
import PostDetailModal from '@/components/PostDetailModal';
import EditPostModal from '@/components/EditPostModal';
import QBoardPostModal from '@/components/QBoardPostModal';
import './album.css';

export default function AlbumPage() {
  const { userCode } = useAuth();

  // ✅ userCode 取得ログ
  useEffect(() => {
    if (!userCode) {
      console.warn('[AlbumPage] ⚠️ userCode が未取得です');
    } else {
      console.log('[AlbumPage] ✅ userCode 取得:', userCode);
    }
  }, [userCode]);

  const [posts, setPosts] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'new' | 'old' | 'title'>('new');
  const [selectedPost, setSelectedPost] = useState<any>(null);
  const [isEditOpen, setIsEditOpen] = useState(false);

  // 🔽 Q投稿モード
  const [isQMode, setIsQMode] = useState(false);
  const [selectedPosts, setSelectedPosts] = useState<any[]>([]);
  const [isQModalOpen, setIsQModalOpen] = useState(false);

  const fetchPosts = async () => {
    if (!userCode) {
      console.warn('[AlbumPage] ⛔ userCode が無いため fetchPosts 中止');
      return;
    }

    console.log('[AlbumPage] 🔄 投稿を取得中...');

    try {
      const res = await fetch('/api/my-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: userCode }),
      });

      const data = await res.json();

      if (data.posts) {
        console.log('[AlbumPage] ✅ 投稿取得成功', data.posts.length);
        setPosts(data.posts);
      } else {
        console.warn('[AlbumPage] ⚠️ 投稿データが空です');
      }
    } catch (err) {
      console.error('[AlbumPage] ❌ 投稿取得失敗:', err);
    }
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

  const toggleSelect = (post: any) => {
    const exists = selectedPosts.find((p) => p.post_id === post.post_id);
    if (exists) {
      console.log('[AlbumPage] ❎ 選択解除:', post.post_id);
      setSelectedPosts((prev) => prev.filter((p) => p.post_id !== post.post_id));
    } else {
      console.log('[AlbumPage] ✅ 選択追加:', post.post_id);
      setSelectedPosts((prev) => [...prev, post]);
    }
  };

  return (
    <div className="album-page">
      <h2>あなたのアルバム</h2>

      {/* 🔍 検索 & ソート */}
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

      {/* 🖼️ 投稿カード */}
      <div className="album-grid">
        {filtered.map((post) => (
          <AlbumCard
            key={post.post_id}
            post={post}
            isQMode={isQMode}
            isChecked={selectedPosts.some((p) => p.post_id === post.post_id)}
            onQSelect={() => toggleSelect(post)}
            onClick={() => {
              if (isQMode) {
                console.log('[AlbumPage] 🌀 Qモードクリック');
                toggleSelect(post);
              } else {
                console.log('[AlbumPage] 📸 通常モード → モーダル表示');
                setSelectedPost(post);
                setIsEditOpen(true);
              }
            }}
            onEdit={() => {
              console.log('[AlbumPage] ✏️ 編集クリック');
              setSelectedPost(post);
              setIsEditOpen(true);
            }}
          />
        ))}
      </div>

      {/* 🚀 Q投稿モーダル */}
      {isQModalOpen && (
        <QBoardPostModal
          posts={selectedPosts}
          userCode={userCode || ''}
          onClose={() => {
            console.log('[AlbumPage] 🔚 Q投稿モーダル閉じる');
            setIsQModalOpen(false);
            setIsQMode(false);
            setSelectedPosts([]);
            fetchPosts();
          }}
        />
      )}

      {/* ✏️ 編集モーダル */}
      {isEditOpen && selectedPost && (
        <EditPostModal
          isOpen={isEditOpen}
          onClose={() => {
            setIsEditOpen(false);
            setSelectedPost(null);
          }}
          post={selectedPost}
          onEditSuccess={(updated) => {
            console.log('[AlbumPage] 🔄 投稿更新', updated.post_id);
            setPosts((prev) =>
              prev.map((p) => (p.post_id === updated.post_id ? updated : p))
            );
          }}
          onDeleteSuccess={(deletedId) => {
            console.log('[AlbumPage] 🗑️ 投稿削除', deletedId);
            setPosts((prev) => prev.filter((p) => p.post_id !== deletedId));
          }}
        />
      )}

      {/* 🔍 詳細モーダル */}
      {selectedPost && !isEditOpen && (
        <PostDetailModal
          post={selectedPost}
          onClose={() => {
            console.log('[AlbumPage] 🔙 詳細モーダル閉じる');
            setSelectedPost(null);
          }}
          onUpdated={fetchPosts}
        />
      )}

      {/* ✅ Qボタン */}
      <button
        onClick={() => {
          if (!isQMode) {
            console.log('[AlbumPage] ✅ Qモード ON');
            setIsQMode(true);
          } else if (selectedPosts.length > 0) {
            console.log('[AlbumPage] 🚀 Q投稿モーダル開く');
            setIsQModalOpen(true);
          } else {
            console.log('[AlbumPage] ⚠️ 画像が選択されていません');
          }
        }}
        style={{
          position: 'fixed',
          bottom: 80,
          right: 20,
          width: 60,
          height: 60,
          borderRadius: '50%',
          background: '#ff4dd2',
          color: '#fff',
          fontSize: 28,
          border: 'none',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          cursor: 'pointer',
          zIndex: 100,
        }}
      >
        Q
      </button>
    </div>
  );
}
