'use client';

import React from 'react';
import type { Post } from '@/types/post';

type Props = {
  posts: Post[];
  userCode: string;
  onClose: () => void;
  onSubmit?: (payload: { posts: Post[]; userCode: string }) => void;
};

export default function QBoardPostModal({ posts, userCode, onClose, onSubmit }: Props) {
  const preview = Array.isArray(posts) ? posts : [];
  return (
    <div role="dialog" aria-modal="true" /* ...スタイル省略... */>
      {/* ...プレビューUI... */}
      <button onClick={onClose}>閉じる</button>
      <button onClick={() => onSubmit?.({ posts: preview, userCode })}>投稿する</button>
    </div>
  );
}
