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
  const [content, setContent] = useState('');
  const [mediaUrls, setMediaUrls] = useState<string[]>([]);
  const [isPosting, setIsPosting] = useState(false);

  useEffect(() => {
    console.log('📍 QBoardPostModal 表示開始');
    console.log('🧾 userCode:', userCode);
    console.log('🖼️ posts:', posts);

    const initialUrls = posts.flatMap((p) => p.media_urls || []);
    const uniqueUrls = Array.from(new Set(initialUrls)); // ✅ 重複排除
    setMediaUrls(uniqueUrls);
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

      const tagArray = tags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);

      const postData = {
        user_code: userCode,
        title,
        content,
        category,
        tags: tagArray,
        media_urls: publicUrls,
        visibility: 'public',
        layout_type: 'default',
        board_type: 'default',
      };

      console.log('📝 投稿データ送信:', postData);

      const response = await fetch('/api/upload-post', {
        method: 'POST',
        body: JSON.stringify(postData),
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
        <input
          type="text"
          placeholder="タグ（カンマ区切り）"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        <textarea
          placeholder="コメント・説明（任意）"
          value={content}
          onChange={(e) => setContent(e.target.value)}
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
