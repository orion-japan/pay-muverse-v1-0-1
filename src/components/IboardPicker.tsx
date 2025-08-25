'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import './IboardPicker.css';

type IboardPost = {
  post_id: string;
  media_urls: string[] | null;
};

type IboardPickerProps = {
  userCode: string;                 // 自分の投稿だけ取得
  selectedPostId?: string | null;   // 既存の選択状態（編集時）
  onSelect: (postId: string, thumbnailUrl: string) => void; // 1枚確定
  onClose?: () => void;             // モーダル閉じる等で利用する場合
  limit?: number;                   // 取得件数（任意）
};

export default function IboardPicker({
  userCode,
  selectedPostId,
  onSelect,
  onClose,
  limit = 60,
}: IboardPickerProps) {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [posts, setPosts] = useState<IboardPost[]>([]);
  const [current, setCurrent] = useState<string | null>(selectedPostId ?? null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        setErrorMsg(null);

        // 自分の iBoard 投稿のみ取得（サムネイルだけ使うので media_urls のみ）
        const { data, error } = await supabase
          .from('posts')
          .select('post_id, media_urls')
          .eq('user_code', userCode)
          .eq('board_type', 'iBoard')
          .order('created_at', { ascending: false })
          .limit(limit);

        if (error) throw error;
        if (!mounted) return;

        const filtered = (data || []).filter(p => Array.isArray(p.media_urls) && p.media_urls.length > 0);
        setPosts(filtered);
      } catch (e: any) {
        setErrorMsg(e.message || '読み込みに失敗しました');
      } finally {
        setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [userCode, limit]);

  const handleClick = (p: IboardPost) => {
    const thumb = (p.media_urls && p.media_urls[0]) || '';
    setCurrent(p.post_id);
    onSelect(p.post_id, thumb);
  };

  return (
    <div className="ibp-shell">
      <div className="ibp-header">
        <div className="ibp-title">iBoardから画像を選択</div>
        {onClose && (
          <button className="ibp-close" onClick={onClose} aria-label="閉じる">×</button>
        )}
      </div>

      {loading && <div className="ibp-status">読み込み中…</div>}
      {errorMsg && <div className="ibp-error">⚠ {errorMsg}</div>}

      {!loading && !errorMsg && (
        <div className="ibp-grid">
          {posts.map((p) => {
            const src = (p.media_urls && p.media_urls[0]) || '';
            const isSel = current === p.post_id;
            return (
              <button
                key={p.post_id}
                className={`ibp-card ${isSel ? 'is-selected' : ''}`}
                onClick={() => handleClick(p)}
                aria-label="iBoard画像を選択"
              >
                {/* 画像だけ（テキストなし） */}
                <img src={src} alt="" className="ibp-thumb" />
                {isSel && <div className="ibp-check">✓</div>}
              </button>
            );
          })}
          {posts.length === 0 && (
            <div className="ibp-empty">iBoardに画像投稿がありません。</div>
          )}
        </div>
      )}
    </div>
  );
}
