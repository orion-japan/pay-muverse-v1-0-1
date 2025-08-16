'use client';

import React from 'react';
import './AlbumCard.css';

type Post = {
  post_id: string;
  title?: string;
  content?: string;
  media_urls: string[];
  tags?: string[];
  created_at: string;
};

type AlbumCardProps = {
  post: Post;
  isQMode: boolean;
  isChecked: boolean;
  onQSelect: () => void;
  onClick: () => void;
  onEdit?: () => void;
};

export default function AlbumCard({
  post,
  isQMode,
  isChecked,
  onQSelect,
  onClick,
  onEdit,
}: AlbumCardProps) {
  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    console.log('[AlbumCard] ✏️ 編集ボタンが押されました');
    if (onEdit) onEdit();
  };

  return (
    <div
      className={`album-card ${isQMode ? 'q-mode' : ''} ${isChecked ? 'checked blink' : ''}`}
      onClick={() => {
        if (isQMode) {
          console.log('[AlbumCard] ✅ Qモード画像クリック → onQSelect 実行');
          onQSelect();
        } else {
          console.log('[AlbumCard] 📸 通常モード画像クリック → onClick 実行');
          onClick();
        }
      }}
    >
      {/* Qモード時のチェックボックス（非表示でクリック対応） */}
      {isQMode && (
        <input
          type="checkbox"
          checked={isChecked}
          onChange={(e) => {
            e.stopPropagation();
            console.log('[AlbumCard] ✅ チェックボックスが切り替えられました');
            onQSelect();
          }}
          className="q-checkbox"
        />
      )}

      {/* 画像表示エリア：複数 → 横スライド／単数 → 通常表示 */}
      {post.media_urls.length > 1 ? (
        <div className="image-carousel">
          {post.media_urls.map((url, index) => (
            <img
              key={index}
              src={url}
              alt={`Image ${index}`}
              className="carousel-image"
              onError={(e) => {
                console.warn('[AlbumCard] ⚠️ 画像読み込み失敗:', url);
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          ))}
        </div>
      ) : (
        <img
          src={post.media_urls[0] || ''}
          alt="Album Image"
          className="album-image"
          onError={(e) => {
            console.warn('[AlbumCard] ⚠️ 画像読み込み失敗:', post.media_urls[0]);
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      )}

      {/* 編集ボタン（オプション） */}
      {onEdit && (
        <button className="edit-btn" onClick={handleEditClick}>
          ✏️
        </button>
      )}
    </div>
  );
}
