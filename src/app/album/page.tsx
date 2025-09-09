'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import AlbumCard from '@/components/AlbumCard';
import PostDetailModal from '@/components/PostDetailModal';
import EditPostModal from '@/components/EditPostModal';
import QBoardPostModal from '@/components/QBoardPostModal';
import './album.css';

// ★ 追加：コラージュ側と同じアルバム取得ロジックを利用
import { supabase } from '@/lib/supabase';

type Post = {
  post_id: string;
  title?: string | null;
  content?: string | null;
  media_urls: string[];
  tags?: string[];
  created_at: string;
  board_type?: string | null; // ← これを追加
};

// ★ 追加：private-posts からアルバム一覧（署名URL）を取得
type AlbumItem = {
  name: string;
  url: string;    // 表示用（署名URL）
  path: string;   // private-posts/<userCode>/<file>
  size?: number | null;
  updated_at?: string | null;
};
const ALBUM_BUCKET = 'private-posts';

async function listAlbumImages(userCode: string): Promise<AlbumItem[]> {
  try {
    const ucode = (userCode || '').trim();
    if (!ucode) return [];
    const prefix = `${ucode}`;
    const { data, error } = await supabase.storage.from(ALBUM_BUCKET).list(prefix, {
      limit: 200,
      sortBy: { column: 'updated_at', order: 'desc' },
    });
    if (error) throw error;

    const files = (data || []).filter((f) => !f.name.startsWith('.') && !f.name.endsWith('/'));
    const resolved = await Promise.all(
      files.map(async (f) => {
        const path = `${prefix}/${f.name}`;
        const { data: signed } = await supabase.storage.from(ALBUM_BUCKET).createSignedUrl(path, 60 * 30);
        return {
          name: f.name,
          url: signed?.signedUrl ?? '',
          path,
          size: (f as any)?.metadata?.size ?? null,
          updated_at: (f as any)?.updated_at ?? null,
        };
      })
    );
    return resolved;
  } catch (e) {
    console.warn('[AlbumPage] listAlbumImages error:', e);
    return [];
  }
}

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
      // 1) 既存の自分の投稿
      const res = await fetch('/api/my-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: userCode }),
      });

      let apiPosts: Post[] = [];
      if (!res.ok) {
        const text = await res.text().catch(() => '(no body)');
        console.error('[AlbumPage] /api/my-posts NG', res.status, text);
      } else {
        const data = await res.json().catch((e) => {
          console.error('[AlbumPage] JSON parse error:', e);
          return null;
        });
        apiPosts = Array.isArray(data?.posts) ? (data!.posts as Post[]) : [];
        console.log('[AlbumPage] posts loaded:', apiPosts.length);
      }

      // 2) コラージュと同じ：private-posts/<userCode>/ からアルバム画像
      const albumItems = await listAlbumImages(String(userCode));
      const albumPosts: Post[] = albumItems.map((it) => ({
        post_id: `album://${it.path}`,                // 一意キーとして path を利用
        title: it.name || null,
        content: null,
        media_urls: it.url ? [it.url] : [],
        tags: [],
        created_at: it.updated_at ?? new Date().toISOString(),
        board_type: 'album',                           // ← ここで 'album' を明示
      }));

      // 3) マージ（重複 post_id は API 側を優先）
      const mergedMap = new Map<string, Post>();
      for (const p of albumPosts) mergedMap.set(p.post_id, p);
      for (const p of apiPosts) mergedMap.set(p.post_id, p);

      const merged = Array.from(mergedMap.values());
      setPosts(merged);
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
        if (sort === 'new') return +new Date(b.created_at) - +new Date(a.created_at);
        if (sort === 'old') return +new Date(a.created_at) - +new Date(b.created_at);
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

  // ===== 追加: iボード作成（+I）と同じ挙動を共通関数化 =====
  const handleIBoardCreate = () => {
    if (!isQMode) {
      setIsQMode(true);            // まず選択モードへ
    } else if (selectedIds.size > 0) {
      setIsQModalOpen(true);       // 選択済みなら投稿へ
    }
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

<div className="album-action-bar">
  <div className="album-action-inner">
  <a href="/collage" className="action-btn collage">＋ コラージュ作成</a>
    <button onClick={handleIBoardCreate} className="action-btn iboard">＋ iボード作成</button>
  </div>
</div>
<div className="album-bottom-spacer" />


      {/* 既存のフローティング +I ボタンは残しつつ非表示化（構造保持・導線は下部バーに集約） */}
      <button
        onClick={handleIBoardCreate}
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
          display: 'none', // ← 導線を下部バーに統一
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
            bottom: 80 + 54, // アクションバー＋マージンの上
            right: 20,
            width: 60,
            height: 36,
            borderRadius: 12,
            background: '#666',
            color: '#fff',
            border: 'none',
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            cursor: 'pointer',
            zIndex: 120,
          }}
        >
          解除
        </button>
      )}
    </div>
  );
}
