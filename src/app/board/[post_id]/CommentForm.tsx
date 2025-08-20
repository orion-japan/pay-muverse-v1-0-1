'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';

type Props = {
  postId: string;
  onPosted?: () => void;
};

export default function CommentForm({ postId, onPosted }: Props) {
  const { userCode } = useAuth(); // 既存の AuthContext を利用
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const router = useRouter();

  const submit = async () => {
    if (!userCode) {
      alert('コメントにはログインが必要です。');
      return;
    }
    const content = text.trim();
    if (!content) return;

    setSending(true);
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post_id: postId,
          user_code: userCode,
          content,
        }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error || 'コメントの送信に失敗しました');
      }

      // 成功
      setText('');
      onPosted?.();

      // SSR 再取得で一覧を更新
      router.refresh();

      // 一番下へスクロール（アンカー必須: <div id="comments-bottom" />）
      setTimeout(() => {
        const el = document.getElementById('comments-bottom');
        el?.scrollIntoView({ behavior: 'smooth' });
      }, 60);
    } catch (e: any) {
      alert(e?.message || 'エラーが発生しました');
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
      <label htmlFor="comment-textarea" style={{ fontSize: 14, color: '#555' }}>
        コメントを書く
      </label>
      <textarea
        id="comment-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder={userCode ? 'ここに入力…' : 'コメントするにはログインしてください'}
        style={{
          width: '100%',
          padding: 10,
          borderRadius: 8,
          border: '1px solid #ddd',
          resize: 'vertical',
        }}
      />
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: 12, color: '#888' }}>
          {text.trim().length} 文字
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={sending || !userCode || text.trim().length === 0}
          style={{
            padding: '8px 14px',
            borderRadius: 10,
            border: 'none',
            background: sending || !userCode || text.trim().length === 0 ? '#bbb' : '#7b5cff',
            color: '#fff',
            cursor: sending || !userCode || text.trim().length === 0 ? 'not-allowed' : 'pointer',
            minWidth: 120,
          }}
          aria-busy={sending}
        >
          {sending ? '送信中…' : 'コメントを送信'}
        </button>
      </div>
    </div>
  );
}
