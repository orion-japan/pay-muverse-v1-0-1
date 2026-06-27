'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authedFetch, useAuth } from '@/context/AuthContext';

export default function MuEntryPage() {
  const router = useRouter();
  const { loading, user } = useAuth();
  const [entryMessage, setEntryMessage] = useState('');
  const [messageLoading, setMessageLoading] = useState(false);

  useEffect(() => {
    if (loading || !user) return;
    authedFetch('/api/mu-journey/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'page_view',
        source: 'app',
        pagePath: '/mu-entry',
        metadata: { area: 'imaginal_first_entry' },
      }),
    }).catch(() => {});
  }, [loading, user]);

  useEffect(() => {
    if (loading || !user || entryMessage || messageLoading) return;

    let cancelled = false;
    setMessageLoading(true);

    authedFetch('/api/mu/entry-message', { method: 'GET' })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;

        if (res.ok && data?.ok && typeof data.message === 'string' && data.message.trim()) {
          setEntryMessage(data.message.trim());
          return;
        }

        setEntryMessage(defaultEntryMessage);
      })
      .catch(() => {
        if (!cancelled) setEntryMessage(defaultEntryMessage);
      })
      .finally(() => {
        if (!cancelled) setMessageLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loading, user, entryMessage, messageLoading]);

  if (loading) return <main style={styles.center}>確認中です…</main>;

  if (!user) {
    return (
      <main style={styles.shell}>
        <section style={styles.card}>
          <p style={styles.kicker}>Muverse</p>
          <h1 style={styles.title}>ログインが必要です</h1>
          <p style={styles.text}>はじめてのイマジナル診断を使うには、登録またはログインを完了してください。</p>
          <button style={styles.button} onClick={() => router.push('/')}>
            登録ページへ戻る
          </button>
        </section>
      </main>
    );
  }

  return (
    <main style={styles.shell}>
      <section style={styles.card}>
        <p style={styles.kicker}>Muへようこそ</p>
        <h1 style={styles.title}>まず、あなたのイマジナルを見てみましょう。</h1>

        <div style={styles.messageWindow}>
          <p style={styles.messageLabel}>Mu</p>
          <p style={styles.muMessage}>
            {messageLoading && !entryMessage ? 'いま、あなたの入口の流れを見ています…' : entryMessage || defaultEntryMessage}
          </p>
        </div>

        <div style={styles.benefitBox}>
          <p style={styles.benefit}>最初に選べる入口</p>
          <p style={styles.benefitDetail}>画像を送って、はじめてのイマジナル診断を受ける</p>
          <p style={styles.benefitDetail}>第1章を読んで、法則の入口から入る</p>
        </div>

        <div style={styles.buttonGroup}>
          <button style={styles.button} onClick={() => router.push('/mu-first')}>
            画像を送って診断する
          </button>
          <button style={styles.secondaryButton} onClick={() => router.push('/books')}>
            第1章を読む
          </button>
        </div>
      </section>
    </main>
  );
}

const defaultEntryMessage = [
  'Muへようこそ。',
  '',
  '願いは、見続けている未来の方向へ進みます。',
  '',
  'いま入口に立っているあなたには、すぐに答えを探すよりも、まず「自分がどんな未来を先に見ているのか」を確かめる流れが出ています。',
  '',
  '気になっている画像を1枚送ると、Muが今のイマジナルを映します。',
  '先に第1章を読んで、法則の入口から入っても大丈夫です。',
].join('\n');

const styles: Record<string, React.CSSProperties> = {
  shell: {
    minHeight: '100dvh',
    display: 'grid',
    placeItems: 'center',
    padding: 20,
    background: 'linear-gradient(180deg, #f7f8ff 0%, #f6f1ec 58%, #ffffff 100%)',
  },
  center: {
    minHeight: '100dvh',
    display: 'grid',
    placeItems: 'center',
  },
  card: {
    width: '100%',
    maxWidth: 430,
    background: 'rgba(255,255,255,0.94)',
    borderRadius: 24,
    padding: 24,
    boxShadow: '0 16px 40px rgba(0,0,0,0.08)',
    border: '1px solid rgba(138,106,79,0.12)',
  },
  kicker: { margin: 0, fontSize: 13, color: '#8a6a4f', fontWeight: 700 },
  title: { margin: '10px 0 16px', fontSize: 24, lineHeight: 1.35, color: '#222' },
  text: { fontSize: 15, lineHeight: 1.8, color: '#444' },
  messageWindow: {
    margin: '18px 0 20px',
    padding: 16,
    borderRadius: 20,
    background: '#fbf7f1',
    border: '1px solid rgba(138,106,79,0.14)',
  },
  messageLabel: {
    margin: '0 0 8px',
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: '0.08em',
    color: '#8a6a4f',
  },
  muMessage: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    fontSize: 14,
    lineHeight: 1.9,
    color: '#3c332d',
  },
  benefitBox: { margin: '20px 0', padding: 16, borderRadius: 16, background: '#fff7ed' },
  benefit: { margin: '0 0 8px', fontWeight: 700, color: '#8a4b15' },
  benefitDetail: { margin: '4px 0', color: '#5b4636', fontSize: 14, lineHeight: 1.6 },
  buttonGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  button: {
    width: '100%',
    border: 'none',
    borderRadius: 999,
    padding: '14px 18px',
    background: '#222',
    color: '#fff',
    fontWeight: 700,
    fontSize: 15,
    cursor: 'pointer',
  },
  secondaryButton: {
    width: '100%',
    border: '1px solid rgba(34,34,34,0.14)',
    borderRadius: 999,
    padding: '14px 18px',
    background: '#fff',
    color: '#2d241f',
    fontWeight: 700,
    fontSize: 15,
    cursor: 'pointer',
  },
};
