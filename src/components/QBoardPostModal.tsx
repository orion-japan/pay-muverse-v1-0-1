'use client';

import { useEffect, useState } from 'react';
import { copyImageToPublic } from '@/lib/copyImageToPublic';
import './QBoardPostModal.css';

type Post = {
  post_id: string;
  media_urls: string[];
  title?: string;
  content?: string;
  tags?: string[];
  created_at: string;
};

type QBoardPostModalProps = {
  posts: Post[];
  userCode: string;
  onClose: () => void;
  onPosted?: () => void;
};

export default function QBoardPostModal({
  posts,
  userCode,
  onClose,
  onPosted,
}: QBoardPostModalProps) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [mediaUrls, setMediaUrls] = useState<string[]>([]);
  const [isPosting, setIsPosting] = useState(false);

  useEffect(() => {
    console.log('📍 QBoardPostModal 表示開始');
    console.log('🧾 userCode:', userCode);
    console.log('🖼️ posts:', posts);

    // 初期値として posts の media_urls をセット
    const initialUrls = posts.flatMap((p) => p.media_urls || []);
    setMediaUrls(initialUrls);
  }, [posts, userCode]);

  const handlePost = async () => {
    try {
      if (!userCode) return alert('ユーザーコードが取得できません');
      if (!title || !category || !tags) {
        return alert('タイトル・カテゴリ・タグは必須です');
      }
      if (mediaUrls.length === 0) {
        return alert('投稿する画像がありません');
      }

      setIsPosting(true);
      console.log('🟡 投稿処理開始', { title, category, tags, mediaUrls });

      const publicUrls: string[] = [];

      // 画像を public-posts にコピー
      for (const url of mediaUrls) {
        console.log('📤 画像コピー開始:', url);
        try {
          const publicUrl = await copyImageToPublic(url, userCode);
          if (publicUrl) {
            publicUrls.push(publicUrl);
            console.log('✅ コピー成功:', publicUrl);
          } else {
            console.warn('⚠️ コピー失敗:', url);
          }
        } catch (err) {
          console.error('❌ コピー中にエラー:', err);
        }
      }

      if (publicUrls.length === 0) {
        alert('画像コピーに失敗しました');
        return;
      }

      // タグを整形
      const tagArray = tags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);

      console.log('📝 投稿情報をSupabaseに送信...', {
        user_code: userCode,
        title,
        category,
        tags: tagArray,
        media_urls: publicUrls,
      });

      const response = await fetch('/api/upload-post', {
        method: 'POST',
        body: JSON.stringify({
          user_code: userCode,
          title,
          content: '',
          category,
          tags: tagArray,
          media_urls: publicUrls,
          visibility: 'public',
        }),
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const result = await response.json().catch(() => ({}));
      if (response.ok) {
        console.log('✅ 投稿成功:', result);
        onPosted?.();
        onClose();
      } else {
        console.error(`❌ 投稿失敗 [${response.status}]`, result);
        alert('投稿に失敗しました: ' + (result.error || '不明なエラー'));
      }
    } catch (error) {
      console.error('❌ 投稿処理中にエラー:', error);
      alert('エラーが発生しました');
    } finally {
      setIsPosting(false);
      console.log('🟢 投稿処理完了');
    }
  };

  return (
    <div className="qboard-modal">
      <div className="modal-content">
        <h2>Qボードに投稿</h2>

        <input
          type="text"
          placeholder="タイトル"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input
          type="text"
          placeholder="カテゴリ"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <input
          type="text"
          placeholder="タグ（カンマ区切り）"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />

        {mediaUrls.length > 0 && (
          <div className="preview-container">
            {mediaUrls.map((url, idx) => (
              <img
                key={idx}
                src={url}
                alt={`preview-${idx}`}
                className="preview-image"
              />
            ))}
          </div>
        )}

        <button onClick={handlePost} disabled={isPosting}>
          {isPosting ? '投稿中...' : '投稿する'}
        </button>
        <button onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}
