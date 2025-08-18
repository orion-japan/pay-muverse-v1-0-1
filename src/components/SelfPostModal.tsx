// src/components/SelfPostModal.tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import './SelfPostModal.css';

type SelfPostModalProps = {
  isOpen: boolean;
  onClose: () => void;
  userCode: string;
  /** Selfページから 'self' を渡す。未指定なら null 保存 */
  boardType?: string | null;
  /** 正式コールバック名（互換維持） */
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
  const router = useRouter();

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const [visibility, setVisibility] = useState<'public' | 'private' | 'friends'>('public');


  useEffect(() => {
    if (!isOpen) {
      setTitle('');
      setContent('');
      setTags('');
      setImageFile(null);
      setPreviewUrl('');
      setIsPosting(false);
      setVisibility('public'); // モーダル閉じたらリセット
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

      // タグと board_type を正規化
      const normalizedTags = tags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);

      const resolvedBoardType =
        boardType === undefined ||
        boardType === null ||
        String(boardType).trim().toLowerCase() === 'null' ||
        String(boardType).trim() === ''
          ? null
          : String(boardType).trim();

      // 1) 親（posts）を1件だけ作成
      const parentBody = {
        user_code: userCode,
        title: title.trim() || null,
        content: (content || '').trim() || null,
        tags: normalizedTags.length ? normalizedTags : null,
        media_urls: uploadedUrl ? [uploadedUrl] : [],
        board_type: resolvedBoardType ?? 'self',
        visibility, // ← 追加！
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

        {/* ✅ 公開範囲セレクトボックス */}
        <label>公開範囲:</label>
        <select
  value={visibility}
  onChange={(e) =>
    setVisibility(e.target.value as 'public' | 'private' | 'friends')
  }
  
>
  <option value="public">🌐 公開（全体に表示）</option>
  <option value="friends">👥 友達のみ（限定表示）</option>
  <option value="private">🔒 非公開（自分のみ）</option>
</select>


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
