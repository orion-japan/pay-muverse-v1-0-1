'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import AlbumCard from '@/components/AlbumCard';
import PostDetailModal from '@/components/PostDetailModal';
import EditPostModal from '@/components/EditPostModal';
import QBoardPostModal from '@/components/QBoardPostModal';
import './album.css';

type Post = {
  post_id: string;
  title?: string | null;
  content?: string | null;
  media_urls: string[];
  tags?: string[];
  created_at: string;
  board_type?: string | null; // ← これを追加
};

export default function AlbumPage() {
  const { userCode } = useAuth();

  useEffect(() => {
    if (!userCode) console.warn('[AlbumPage] userCode 未取得');
    else console.log('[AlbumPage] userCode:', userCode);
  }, [userCode]);

  const [posts, setPosts] = useState<Post[]>([]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'new' | 'old' | 'title'>('new');

  const [selectedPost, setSelectedPost] = useState<Post | null>(null);
  const [isEditOpen, setIsEditOpen] = useState(false);

  // --- Qモード ---
  const [isQMode, setIsQMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isQModalOpen, setIsQModalOpen] = useState(false);

  const fetchPosts = async () => {
    if (!userCode) return;
    try {
      const res = await fetch('/api/my-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: userCode }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '(no body)');
        console.error('[AlbumPage] /api/my-posts NG', res.status, text);
        return;
      }

      const data = await res.json().catch((e) => {
        console.error('[AlbumPage] JSON parse error:', e);
        return null;
      });

      if (data?.posts) {
        console.log('[AlbumPage] posts loaded:', data.posts.length);
        setPosts(data.posts);
      } else {
        console.warn('[AlbumPage] no posts in response:', data);
      }
    } catch (e) {
      console.error('[AlbumPage] fetchPosts error:', e);
    }
  };

  useEffect(() => {
    fetchPosts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userCode]);

  const filtered = useMemo(() => {
    const list = posts
      // board_type の表示対象を拡張（'album' | 'default' | 'self' | null/空 を表示）
      .filter((p) => {
        const bt = (p.board_type ?? '').toLowerCase();
        return bt === '' || bt === 'album' || bt === 'default' || bt === 'self';
      })
      .filter((p) =>
        [p.title, p.content, ...(p.tags || [])]
          .join(' ')
          .toLowerCase()
          .includes(search.toLowerCase())
      )
      .sort((a, b) => {
        if (sort === 'new')
          return +new Date(b.created_at) - +new Date(a.created_at);
        if (sort === 'old')
          return +new Date(a.created_at) - +new Date(b.created_at);
        return (a.title || '').localeCompare(b.title || '');
      });
    return list;
  }, [posts, search, sort]);

  const toggleSelect = (postId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  };

  const resetQMode = () => {
    setIsQMode(false);
    setSelectedIds(new Set());
    setIsQModalOpen(false);
  };

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
            isQMode={isQMode}
            isChecked={selectedIds.has(post.post_id)}
            onQSelect={() => toggleSelect(post.post_id)}
            onClick={() => {
              if (isQMode) {
                toggleSelect(post.post_id);
              } else {
                setSelectedPost(post);
                setIsEditOpen(true);
              }
            }}
            onEdit={() => {
              setSelectedPost(post);
              setIsEditOpen(true);
            }}
          />
        ))}
      </div>

      {/* Q投稿モーダル */}
      {isQModalOpen && (
        <QBoardPostModal
          posts={filtered.filter((p) => selectedIds.has(p.post_id))}
          userCode={userCode || ''}
          onClose={() => {
            resetQMode();
            fetchPosts();
          }}
        />
      )}

      {/* 編集モーダル */}
      {isEditOpen && !!selectedPost && (
        <EditPostModal
          isOpen={isEditOpen}
          post={selectedPost}
          onClose={() => {
            setIsEditOpen(false);
            setSelectedPost(null);
          }}
          onEditSuccess={(updated) => {
            setPosts((prev) =>
              prev.map((p) => (p.post_id === updated.post_id ? updated : p))
            );
          }}
          onDeleteSuccess={(deletedId) => {
            setPosts((prev) => prev.filter((p) => p.post_id !== deletedId));
          }}
        />
      )}

      {/* Qボタン */}
      <button
        onClick={() => {
          if (!isQMode) {
            setIsQMode(true);
          } else if (selectedIds.size > 0) {
            setIsQModalOpen(true);
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
        aria-label="Qモード/投稿"
      >
        +I
      </button>

      {isQMode && (
        <button
          onClick={resetQMode}
          style={{
            position: 'fixed',
            bottom: 150,
            right: 20,
            width: 60,
            height: 36,
            borderRadius: 12,
            background: '#666',
            color: '#fff',
            border: 'none',
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            cursor: 'pointer',
            zIndex: 100,
          }}
        >
          解除
        </button>
      )}
    </div>
  );
}
