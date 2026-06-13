'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { authedFetch, useAuth } from '@/context/AuthContext';

export default function MuEntryPage() {
  const router = useRouter();
  const { loading, user } = useAuth();

  useEffect(() => {
    if (loading || !user) return;
    authedFetch('/api/mu-journey/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'page_view',
        source: 'app',
        pagePath: '/mu-entry',
        metadata: { area: 'first_entry' },
      }),
    }).catch(() => {});
  }, [loading, user]);

  if (loading) return <main style={styles.center}>確認中です…</main>;

  if (!user) {
    return (
      <main style={styles.shell}>
        <section style={styles.card}>
          <p style={styles.kicker}>Muverse</p>
          <h1 style={styles.title}>ログインが必要です</h1>
          <p style={styles.text}>初回スクショ診断を使うには、登録またはログインを完了してください。</p>
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
        <h1 style={styles.title}>まずは、スクショを1枚見せてください。</h1>
        <p style={styles.text}>
          Muは、相手の気持ちを断定するのではなく、会話の中であなたが今どこで待っているのかを映します。
        </p>
        <div style={styles.benefitBox}>
          <p style={styles.benefit}>初回登録特典</p>
          <p style={styles.benefitDetail}>Muと話せる90クレジット</p>
          <p style={styles.benefitDetail}>スクショ診断1回分</p>
        </div>
        <button style={styles.button} onClick={() => router.push('/mu-first')}>
          初回スクショ診断をはじめる
        </button>
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    minHeight: '100dvh',
    display: 'grid',
    placeItems: 'center',
    padding: 20,
    background: '#f7f7f8',
  },
  center: {
    minHeight: '100dvh',
    display: 'grid',
    placeItems: 'center',
  },
  card: {
    width: '100%',
    maxWidth: 430,
    background: '#fff',
    borderRadius: 24,
    padding: 24,
    boxShadow: '0 16px 40px rgba(0,0,0,0.08)',
  },
  kicker: { margin: 0, fontSize: 13, color: '#8a6a4f', fontWeight: 700 },
  title: { margin: '10px 0 12px', fontSize: 24, lineHeight: 1.35, color: '#222' },
  text: { fontSize: 15, lineHeight: 1.8, color: '#444' },
  benefitBox: { margin: '20px 0', padding: 16, borderRadius: 16, background: '#fff7ed' },
  benefit: { margin: '0 0 8px', fontWeight: 700, color: '#8a4b15' },
  benefitDetail: { margin: '4px 0', color: '#5b4636', fontSize: 14 },
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
};
