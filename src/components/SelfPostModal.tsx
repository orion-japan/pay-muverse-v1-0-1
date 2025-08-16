'use client';

import { useEffect, useState } from 'react';
import './SelfPostModal.css';

type SelfPostModalProps = {
  isOpen: boolean;
  onClose: () => void;
  userCode: string;
  /** Selfページから 'self' を渡す。未指定なら null 保存 */
  boardType?: string | null;
  /** 正式コールバック名 */
  onPostSuccess?: () => void;
  /** 互換用の別名（あれば呼ぶ） */
  onPosted?: () => void;
};

export default function SelfPostModal({
  isOpen,
  onClose,
  userCode,
  boardType = 'self',
  onPostSuccess,
  onPosted,
}: SelfPostModalProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [isPosting, setIsPosting] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setTitle('');
      setContent('');
      setTags('');
      setImageFile(null);
      setPreviewUrl('');
      setIsPosting(false);
    }
  }, [isOpen]);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImageFile(file);
      setPreviewUrl(URL.createObjectURL(file));
    }
  };

  const handlePost = async () => {
    if (!userCode || isPosting) return;

    setIsPosting(true);
    console.log('[SelfPostModal] ▶ 投稿開始', { userCode, boardType });

    try {
      // 1) 画像アップロード（任意）
      let uploadedUrl = '';
      if (imageFile) {
        const formData = new FormData();
        formData.append('file', imageFile);
        formData.append('userCode', userCode);

        console.log('[SelfPostModal] 📤 画像アップロード開始', {
          name: imageFile.name,
          size: imageFile.size,
          type: imageFile.type,
        });

        const imgRes = await fetch('/api/post-image', { method: 'POST', body: formData });
        if (!imgRes.ok) {
          const t = await imgRes.text().catch(() => '');
          console.error('[SelfPostModal] ❌ 画像アップロード失敗', imgRes.status, t);
          throw new Error('画像アップロードに失敗しました');
        }
        const imgData = await imgRes.json();
        uploadedUrl = imgData?.url || '';
        console.log('[SelfPostModal] ✅ 画像アップロード成功', { uploadedUrl });
      }

      // 2) 投稿データ整形
      const normalizedTags =
        tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);

      // board_type: 未指定 or "null" or "" は null にする
      const resolvedBoardType =
        boardType === undefined ||
        boardType === null ||
        String(boardType).trim().toLowerCase() === 'null' ||
        String(boardType).trim() === ''
          ? null
          : String(boardType).trim();

      const body = {
        user_code: userCode,
        title: title.trim() || null,
        content: content.trim() || null,
        tags: normalizedTags.length ? normalizedTags : null,
        media_urls: uploadedUrl ? [uploadedUrl] : [],
        visibility: 'public',
        board_type: resolvedBoardType, // ← ここが重要
      };

      console.log('[SelfPostModal] 📤 投稿送信', body);

      // 3) Self用APIにPOST（/api/upload-post ではなく /api/self-posts）
      const res = await fetch('/api/self-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        console.error('[SelfPostModal] ❌ 投稿失敗', res.status, t);
        throw new Error('投稿に失敗しました');
      }

      const saved = await res.json();
      console.log('[SelfPostModal] ✅ 投稿成功', {
        post_id: saved?.post_id ?? saved?.id,
        board_type: saved?.board_type,
      });

      // 両方あれば両方呼ぶ（後方互換）
      onPostSuccess?.();
      onPosted?.();

      onClose();
    } catch (err) {
      console.error('[SelfPostModal] 💥 投稿エラー', err);
      alert('投稿に失敗しました。コンソールログをご確認ください。');
    } finally {
      setIsPosting(false);
      console.log('[SelfPostModal] ■ 投稿終了');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>📝 つぶやきを投稿</h2>

        <input
          type="text"
          placeholder="タイトル（任意）"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <textarea
          placeholder="いま感じていることを..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />

        <input
          type="text"
          placeholder="タグ（カンマ区切り）"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />

        <input type="file" accept="image/*" onChange={handleImageChange} />

        {previewUrl && <img src={previewUrl} alt="preview" className="preview" />}

        <div className="modal-actions">
          <button onClick={onClose}>キャンセル</button>
          <button onClick={handlePost} disabled={isPosting}>
            {isPosting ? '投稿中...' : '投稿'}
          </button>
        </div>
      </div>
    </div>
  );
}
