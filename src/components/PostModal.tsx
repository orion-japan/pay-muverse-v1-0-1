'use client';

import { useRef, useState } from 'react';
import './PostModal.css';

type PostModalProps = {
  isOpen: boolean;
  onClose: () => void;
  userCode: string;
  onPostSuccess: () => void;
  scrollTargetRef?: React.RefObject<HTMLDivElement>;
};

export default function PostModal({
  isOpen,
  onClose,
  userCode,
  onPostSuccess,
  scrollTargetRef,
}: PostModalProps) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resizeImage = (file: File): Promise<Blob> => {
    return new Promise((resolve) => {
      const img = new Image();
      const reader = new FileReader();

      reader.onload = (e) => {
        img.src = e.target?.result as string;
      };

      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 600;
        const scale = MAX_WIDTH / img.width;

        canvas.width = MAX_WIDTH;
        canvas.height = img.height * scale;

        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);

        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
        }, 'image/jpeg', 0.75);
      };

      reader.readAsDataURL(file);
    });
  };

  const handleImageUpload = async () => {
    if (!userCode || !file) throw new Error('画像ファイルが選択されていません');

    const resized = await resizeImage(file);

    const formData = new FormData();
    formData.append('userCode', userCode);
    formData.append('file', new File([resized], file.name, { type: 'image/jpeg' }));

    const res = await fetch('/api/post-image', {
      method: 'POST',
      body: formData,
    });

    const { urls } = await res.json();

    if (!res.ok || !urls || urls.length === 0) {
      throw new Error('画像アップロード失敗');
    }

    return urls;
  };

  const handleSubmit = async () => {
    if (!userCode || !file || !title) {
      alert('必須項目（タイトル・画像）を入力してください');
      return;
    }

    setIsSubmitting(true);

    try {
      const media_urls = await handleImageUpload();

      const res = await fetch('/api/upload-post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_code: userCode,
          title,
          category,
          content,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          visibility,
          media_urls,
        }),
      });

      if (!res.ok) throw new Error('投稿保存失敗');

      onPostSuccess();
      onClose();

      // ✅ 少し待ってからスクロール（DOM更新完了を待つ）
      setTimeout(() => {
        const el = scrollTargetRef?.current;
        if (el) {
          el.scrollIntoView({ behavior: 'smooth' });
        } else {
          console.warn('[PostModal] スクロールターゲットが見つかりません');
        }
      }, 300); // ← 300ms 待つのが安定
    } catch (err) {
      console.error('[PostModal] ❌ 投稿失敗', err);
      alert('投稿に失敗しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2 className="modal-title">新しい投稿</h2>

        <input
          type="text"
          className="modal-input"
          placeholder="タイトル"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <input
          type="text"
          className="modal-input"
          placeholder="カテゴリ"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />

        <textarea
          className="modal-input"
          placeholder="コメントを入力..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />

        <input
          type="text"
          className="modal-input"
          placeholder="タグ（カンマ区切り）"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />

        <select
          className="modal-input"
          value={visibility}
          onChange={(e) =>
            setVisibility(e.target.value as 'public' | 'private')
          }
        >
          <option value="public">公開</option>
          <option value="private">非公開</option>
        </select>

        <input
          type="file"
          ref={fileInputRef}
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="modal-file"
          accept="image/*"
        />
        {file && <p className="file-name">📎 {file.name}</p>}

        <div className="modal-actions">
          <button onClick={onClose} className="modal-button cancel">
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="modal-button submit"
          >
            {isSubmitting ? '投稿中...' : '投稿'}
          </button>
        </div>
      </div>
    </div>
  );
}
