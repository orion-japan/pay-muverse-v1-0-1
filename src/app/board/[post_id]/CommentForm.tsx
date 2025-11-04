'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuth } from 'firebase/auth';
import { useAuth } from '@/context/AuthContext';

type Props = { postId: string; onPosted?: () => void };

export default function CommentForm({ postId, onPosted }: Props) {
  const { userCode } = useAuth();
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
      // Firebase 認証を使っている場合だけ（無ければ省略可）
      const auth = getAuth();
      const token = auth.currentUser ? await auth.currentUser.getIdToken(true) : null;

      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          post_id: postId, // ← テーブルと一致（snake_case）
          user_code: userCode, // ← これが無いと 400
          content,
        }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false)
        throw new Error(body?.error || 'コメントの送信に失敗しました');

      setText('');
      onPosted?.();
      router.refresh();
      setTimeout(() => {
        document.getElementById('comments-bottom')?.scrollIntoView({ behavior: 'smooth' });
      }, 80);
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
        style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}
      >
        <span style={{ fontSize: 12, color: '#888' }}>{text.trim().length} 文字</span>
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
