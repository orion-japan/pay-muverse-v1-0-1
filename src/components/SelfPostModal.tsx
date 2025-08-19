// src/components/SelfPostModal.tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import './SelfPostModal.css';

type Visibility = 'public' | 'private' | 'friends';

type SelfPostModalProps = {
  isOpen: boolean;
  onClose: () => void;
  userCode: string;
  boardType?: string | null;      // 'self' 推奨
  onPostSuccess?: () => void;     // 互換
  onPosted?: () => void;          // 互換
};

export default function SelfPostModal({
  isOpen,
  onClose,
  userCode,
  boardType = 'self',
  onPostSuccess,
  onPosted,
}: SelfPostModalProps) {
  const router = useRouter();

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const [visibility, setVisibility] = useState<Visibility>('public');

  // モーダル開閉に合わせて初期化＆背景スクロールロック
  useEffect(() => {
    if (!isOpen) {
      setTitle('');
      setContent('');
      setTags('');
      setImageFile(null);
      setPreviewUrl('');
      setIsPosting(false);
      setVisibility('public');
      document.body.style.overflow = '';
      return;
    }
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // ESCで閉じる
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // 画像プレビュー
  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setImageFile(file);
  };

  // プレビューURL生成/解放
  useEffect(() => {
    if (!imageFile) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(imageFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageFile]);

  const handlePost = async () => {
    if (!isOpen || !userCode || isPosting) return;

    setIsPosting(true);
    try {
      // 0) 画像アップロード（任意）
      let uploadedUrl = '';
      if (imageFile) {
        const formData = new FormData();
        formData.append('file', imageFile);
        formData.append('userCode', userCode);

        const imgRes = await fetch('/api/post-image', { method: 'POST', body: formData });
        if (!imgRes.ok) throw new Error('画像アップロードに失敗しました');
        const imgData = await imgRes.json();
        uploadedUrl = imgData?.url || '';
      }

      // タグ・board_type 正規化
      const normalizedTags =
        tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean) || [];

      const resolvedBoardType =
        boardType === undefined ||
        boardType === null ||
        String(boardType).trim().toLowerCase() === 'null' ||
        String(boardType).trim() === ''
          ? null
          : String(boardType).trim();

      // 1) 親（posts）作成
      const parentBody = {
        user_code: userCode,
        title: title.trim() || null,
        content: content.trim() || null,
        tags: normalizedTags.length ? normalizedTags : null,
        media_urls: uploadedUrl ? [uploadedUrl] : [],
        board_type: resolvedBoardType ?? 'self',
        visibility, // public / friends / private
      };

      const res = await fetch('/api/self/create-thread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parentBody),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || '親投稿の作成に失敗しました');

      const threadId: string =
        json?.threadId || json?.thread_id || json?.post_id || json?.post?.post_id;

      if (!threadId) throw new Error('threadId が取得できませんでした');

      onPostSuccess?.();
      onPosted?.();
      onClose();
      router.push(`/thread/${threadId}`);
    } catch (err: any) {
      console.error('[SelfPostModal] 投稿エラー:', err);
      alert(err?.message || '投稿に失敗しました。');
    } finally {
      setIsPosting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose} aria-modal="true" role="dialog">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>📝 つぶやきを投稿</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>

        <div className="modal-body">
          <label className="field">
            <span>タイトル（任意）</span>
            <input
              type="text"
              placeholder="タイトル"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <label className="field">
            <span>本文</span>
            <textarea
              placeholder="いま感じていることを..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>

          <label className="field">
            <span>タグ（カンマ区切り）</span>
            <input
              type="text"
              placeholder="例: #今の声, #S層"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </label>

          <label className="field">
            <span>画像（任意）</span>
            <input type="file" accept="image/*" onChange={handleImageChange} />
          </label>

          {previewUrl && <img src={previewUrl} alt="preview" className="preview" />}

          <label className="field">
            <span>公開範囲</span>
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as Visibility)}
            >
              <option value="public">🌐 公開（全体に表示）</option>
              <option value="friends">👥 友達のみ（限定表示）</option>
              <option value="private">🔒 非公開（自分のみ）</option>
            </select>
          </label>
        </div>

        <footer className="modal-actions">
          <button type="button" onClick={onClose}>
            キャンセル
          </button>
          <button type="button" onClick={handlePost} disabled={isPosting}>
            {isPosting ? '投稿中...' : '投稿'}
          </button>
        </footer>
      </div>
    </div>
  );
}
