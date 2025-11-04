'use client';

import { useState } from 'react';
import './EditPostModal.css';

type Post = {
  post_id: string;
  title?: string;
  category?: string;
  content?: string;
  tags?: string[];
  is_posted?: boolean;
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
  const [isPosted, setIsPosted] = useState(post.is_posted ?? true);
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
        tags: tags.split(',').map((tag) => tag.trim()),
        is_posted: isPosted,
      }),
    });

    setIsSaving(false);

    if (res.ok) {
      const updated = await res.json();
      onEditSuccess({ ...post, ...updated });
      setTimeout(onClose, 100); // 遅延クローズ
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

        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="form-select"
        >
          <option value="">カテゴリを選択</option>
          <option value="投稿">投稿</option>
          <option value="Ｑボード">Ｑボード</option>
          <option value="思い">思い</option>
          <option value="ビジョン">ビジョン</option>
          <option value="報告">報告</option>
          <option value="達成">達成</option>
          <option value="作品">作品</option>
          <option value="学び">学び</option>
          <option value="告知">告知</option>
          <option value="募集">募集</option>
          <option value="HELP">HELP</option>
          <option value="お知らせ">お知らせ</option>
          <option value="その他">その他</option>
        </select>

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
              checked={isPosted}
              onChange={(e) => setIsPosted(e.target.checked)}
            />
            公開する（チェック外すと下書き）
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
