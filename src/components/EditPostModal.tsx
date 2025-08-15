'use client';

import { useState } from 'react';
import './EditPostModal.css';

type Post = {
  post_id: string;
  title?: string;
  category?: string;
  content?: string;
  tags?: string[];
  is_public?: boolean;
  media_urls: string[];
  created_at: string;
};

type EditPostModalProps = {
  isOpen: boolean;
  onClose: () => void;
  post: Post;
  onEditSuccess: (updatedPost: Post) => void;
  onDeleteSuccess: (deletedPostId: string) => void;
};

export default function EditPostModal({
  isOpen,
  onClose,
  post,
  onEditSuccess,
  onDeleteSuccess,
}: EditPostModalProps) {
  const [title, setTitle] = useState(post.title || '');
  const [category, setCategory] = useState(post.category || '');
  const [tags, setTags] = useState(post.tags?.join(', ') || '');
  const [comment, setComment] = useState(post.content || '');
  const [isPublic, setIsPublic] = useState(post.is_public ?? false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!isOpen || !post) return null;

  const handleSave = async () => {
    setIsSaving(true);

    const res = await fetch('/api/update-post', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        post_id: post.post_id,
        title,
        category,
        content: comment,
        tags: tags.split(',').map(tag => tag.trim()),
        is_public: isPublic,
      }),
    });

    setIsSaving(false);

    if (res.ok) {
      const updated = await res.json();
      onEditSuccess({ ...post, ...updated });
      setTimeout(onClose, 100); // 画像肥大化対策の遅延
    } else {
      alert('保存に失敗しました');
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);

    const res = await fetch('/api/delete-post', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_id: post.post_id }),
    });

    setIsDeleting(false);

    if (res.ok) {
      onDeleteSuccess(post.post_id);
      setTimeout(onClose, 100);
    } else {
      alert('削除に失敗しました');
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h2>投稿を編集</h2>

        {post.media_urls?.[0] && (
          <img src={post.media_urls[0]} alt="投稿画像" className="edit-image" />
        )}

        <div className="form-group">
          <label>タイトル</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="input"
          />
        </div>

        <div className="form-group">
          <label>カテゴリー</label>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="input"
          />
        </div>

        <div className="form-group">
          <label>タグ（カンマ区切り）</label>
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="input"
          />
        </div>

        <div className="form-group">
          <label>コメント</label>
          <textarea
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="textarea"
          />
        </div>

        <div className="form-group checkbox-group">
          <label>
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            公開する
          </label>
        </div>

        <div className="modal-buttons">
          <button onClick={handleSave} disabled={isSaving}>
            {isSaving ? '保存中...' : '保存'}
          </button>

          <button
            onClick={() => {
              if (confirmDelete) {
                handleDelete();
              } else {
                setConfirmDelete(true);
              }
            }}
            disabled={isDeleting}
          >
            {confirmDelete ? '本当に削除？' : '削除'}
          </button>

          <button onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
}
