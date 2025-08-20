'use client';

import React from 'react';
import './AlbumCard.css';

type Post = {
  post_id: string;
  title?: string | null;
  content?: string | null;
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
    onEdit?.();
  };

  const firstSrc = post.media_urls?.[0] || '';

  return (
    <div
      className={`album-card ${isQMode ? 'q-mode' : ''} ${isChecked ? 'checked blink' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick();
      }}
    >
      {/* Qモード時だけチェックボックスを前面に */}
      {isQMode && (
        <input
          type="checkbox"
          className="q-checkbox"
          checked={isChecked}
          onChange={(e) => {
            e.stopPropagation();
            onQSelect();
          }}
          onClick={(e) => e.stopPropagation()}
          aria-label="選択"
        />
      )}

      {/* 画像 */}
      <img
        src={firstSrc}
        alt={post.title || 'Album Image'}
        className="album-image"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
        draggable={false}
      />

      {/* 編集ボタン（Qモード中は隠す） */}
      {!!onEdit && !isQMode && (
        <button className="edit-btn" onClick={handleEditClick} aria-label="編集">
          ✏️
        </button>
      )}
    </div>
  );
}
