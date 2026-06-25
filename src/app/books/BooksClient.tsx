'use client';

import { useState } from 'react';
import { authedFetch, useAuth } from '@/context/AuthContext';

const books = Array.from({ length: 10 }, (_, i) => ({
  no: i + 1,
  target_key: `mu_book_${i + 1}`,
  moodle_id: i + 2,
}));

const planText: Record<string, string> = {
  free: 'Free：1章無料ページのみ。Moodle入場は有料プランからです。',
  regular: 'Regular：今月選択した1巻だけ読めます。',
  premium: 'Premium：全Bookを読めます。',
  master: 'Master：全Bookとセッション対象です。',
  partner: 'Partner：全Bookと講座対象です。',
  admin: 'Admin：全Book対象です。Moodle管理者権限はSSOでは渡しません。',
};

export default function BooksClient() {
  const { loading, user, planStatus } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const plan = String(planStatus || 'free').toLowerCase();

  async function openBook(target_key: string) {
    setMessage('');

    if (!user) {
      setMessage('ログイン後に本棚を利用できます。');
      return;
    }

    setBusy(target_key);
    try {
      const res = await authedFetch('/api/moodle/issue-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_key }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data?.ok || !data?.entry_url) {
        setMessage(data?.message || 'このBookには入場できません。');
        return;
      }

      location.assign(data.entry_url);
    } catch (e: any) {
      setMessage(e?.message || 'Moodleへの入場に失敗しました。');
    } finally {
      setBusy(null);
    }
  }

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '28px 16px 56px' }}>
      <section style={{ marginBottom: 18 }}>
        <div style={{ letterSpacing: '.12em', fontSize: 12, opacity: 0.7 }}>Mu Learning</div>
        <h1 style={{ fontSize: 30, margin: '8px 0' }}>Mu Book 本棚</h1>
        <p style={{ lineHeight: 1.8, opacity: 0.82 }}>
          読む場所はMoodleへ。読み終えたら、Muへ戻れるように。ここは、学びの入口を並べる本棚です。
        </p>
      </section>

      <section style={{ border: '1px solid rgba(255,255,255,.16)', borderRadius: 18, padding: 16, marginBottom: 16 }}>
        <strong>{loading ? '確認中...' : user ? `現在のプラン：${plan}` : '未ログイン'}</strong>
        <p style={{ margin: '8px 0 0', lineHeight: 1.7 }}>{user ? planText[plan] || planText.free : 'ログインすると、プランに合わせて入場できます。'}</p>
      </section>

      {message ? (
        <div style={{ border: '1px solid rgba(255,210,120,.45)', borderRadius: 14, padding: 12, marginBottom: 16 }}>
          {message}
        </div>
      ) : null}

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14 }}>
        {books.map((book) => (
          <article key={book.target_key} style={{ border: '1px solid rgba(255,255,255,.14)', borderRadius: 18, padding: 16 }}>
            <div style={{ fontSize: 12, opacity: 0.65 }}>BOOK {book.no}</div>
            <h2 style={{ margin: '8px 0 6px', fontSize: 22 }}>第{book.no}章</h2>
            <p style={{ margin: 0, opacity: 0.72 }}>Moodle id={book.moodle_id}</p>
            <button
              type="button"
              disabled={loading || !user || busy === book.target_key}
              onClick={() => openBook(book.target_key)}
              style={{ width: '100%', marginTop: 14, padding: '12px 14px', borderRadius: 999, border: 0, cursor: loading || !user ? 'not-allowed' : 'pointer' }}
            >
              {busy === book.target_key ? '入場中...' : '読む'}
            </button>
            <p style={{ fontSize: 12, lineHeight: 1.6, opacity: 0.68 }}>
              入場時にMuverse側で権限を確認します。
            </p>
          </article>
        ))}
      </section>
    </main>
  );
}
