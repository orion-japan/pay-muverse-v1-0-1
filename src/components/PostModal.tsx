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
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 画像リサイズ
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

        canvas.toBlob(
          (blob) => {
            if (blob) resolve(blob);
          },
          'image/jpeg',
          0.75,
        );
      };

      reader.readAsDataURL(file);
    });
  };

  // 画像アップロード
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

  // 投稿処理
  const handleSubmit = async () => {
    if (!userCode || !file || !title) {
      alert('必須項目（タイトル・画像）を入力してください');
      return;
    }

    setIsSubmitting(true);

    try {
      const media_urls = await handleImageUpload();

      const res = await fetch('/api/i-posts', {
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
          visibility: 'private', // ✅ 常に private 固定
          is_posted: true,
          media_urls,
          board_type: 'album',
        }),
      });

      if (!res.ok) throw new Error('投稿保存失敗');

      onPostSuccess();
      onClose();

      setTimeout(() => {
        const el = scrollTargetRef?.current;
        if (el) {
          el.scrollIntoView({ behavior: 'smooth' });
        }
      }, 300);
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

        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="form-select"
        >
          <option value="">カテゴリを選択</option>
          <option value="投稿">投稿</option>
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

        <input
          type="text"
          className="modal-input"
          placeholder="タグ（カンマ区切り）"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />

        <textarea
          className="modal-input"
          placeholder="コメントを入力..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />

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
          <button onClick={handleSubmit} disabled={isSubmitting} className="modal-button submit">
            {isSubmitting ? '投稿中...' : '投稿'}
          </button>
        </div>
      </div>
    </div>
  );
}
