'use client';

import { useEffect, useState } from 'react';
import { authedFetch, useAuth } from '@/context/AuthContext';
import styles from './BooksPage.module.css';

const books = Array.from({ length: 10 }, (_, i) => ({
  no: i + 1,
  target_key: `mu_book_${i + 1}`,
  course_id: i + 2,
}));

const planText: Record<string, string> = {
  free: 'Free：第1巻の無料ページのみ。Moodle入場は有料プランからです。',
  regular: 'Regular：今月選択した1巻だけ読めます。選んだ巻が、今月の学びの扉になります。',
  premium: 'Premium：全巻を読めます。気になる巻から、流れに沿って進めます。',
  master: 'Master：全巻とセッション対象です。読むことから、対話と実践へつなげます。',
  partner: 'Partner：全巻と講座対象です。学びを場へ広げる導線が開きます。',
  admin: 'Admin：全巻対象です。Moodle管理者権限はSSOでは渡しません。',
};

const bookCopies = [
  'はじまりの巻。Muverseの入口に触れ、読む準備を整えます。',
  '違和感の輪郭を見つめ、あなたの中にある問いをほどきます。',
  'かがみのように、言葉の奥にある形象を映していきます。',
  '感情の揺れを手がかりに、創造の方向を見つけます。',
  '内面の構造を読み、繰り返しの奥にある流れをつかみます。',
  '形象が育つ場を知り、現実へ向かう力を整えます。',
  'Muとの対話から、読むことを体験へ変えていきます。',
  'フィールドの中で、言葉・行動・現実のつながりを見ます。',
  'ひとつの理解が、次の創造へ開いていく巻です。',
  '第1の旅を統合し、次のMuverseへ橋をかけます。',
];

function normalizePlan(value: unknown) {
  const plan = String(value || 'free').toLowerCase();
  return ['free', 'regular', 'premium', 'master', 'partner', 'admin'].includes(plan) ? plan : 'free';
}

export default function BooksClient() {
  const { loading, user, planStatus } = useAuth();
  const [serverPlan, setServerPlan] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const plan = normalizePlan(serverPlan || planStatus);

  useEffect(() => {
    if (!user) {
      setServerPlan('');
      return;
    }

    let alive = true;
    authedFetch('/api/get-user-info')
      .then((res) => res.json())
      .then((data) => {
        if (!alive) return;
        setServerPlan(data?.click_type || data?.plan || data?.plan_status || '');
      })
      .catch(() => {
        if (alive) setServerPlan('');
      });

    return () => {
      alive = false;
    };
  }, [user]);

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
        setMessage(data?.message || 'この巻には入場できません。');
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
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.hero}>
          <div className={styles.eyebrow}>Mu Learning</div>
          <h1 className={styles.title}>
            Mu Book 本棚
            <span>Reading Field</span>
          </h1>
          <p className={styles.lead}>
            本を読むことは、答えを集めることではなく、内面に眠っていた言葉が動き出すこと。
            ここから、あなたの読む力をMuverseの学びへつなげます。
          </p>
        </section>

        <section className={styles.statusCard}>
          <div>
            <span className={styles.statusLabel}>現在のタイプ</span>
            <strong className={styles.statusValue}>{loading ? '確認中...' : user ? plan : '未ログイン'}</strong>
          </div>
          <p className={styles.statusText}>
            {user ? planText[plan] || planText.free : 'ログインすると、あなたのプランに合わせて入場できます。'}
          </p>
        </section>

        {message ? <div className={styles.notice}>{message}</div> : null}

        <section className={styles.grid} aria-label="Mu Book 本棚">
          {books.map((book) => (
            <article key={book.target_key} className={styles.bookCard}>
              <div className={styles.bookTop}>
                <div className={styles.bookNo}>BOOK {book.no}</div>
                <div className={styles.courseId}>course {book.course_id}</div>
              </div>

              <h2 className={styles.bookTitle}>第{book.no}巻</h2>
              <p className={styles.bookCopy}>{bookCopies[book.no - 1]}</p>

              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={loading || !user || busy === book.target_key}
                  onClick={() => openBook(book.target_key)}
                  className={styles.readButton}
                >
                  {busy === book.target_key ? '扉を開いています...' : 'この巻を読む'}
                </button>
              </div>

              <p className={styles.cardNote}>入場時にMuverse側で権限を確認します。</p>
            </article>
          ))}
        </section>

        <p className={styles.footerHint}>
          Freeは無料ページへ。Regularは今月選んだ1巻へ。Premium以上は全巻へ。
          権限の最終判定は、入場時にMuverse側で行います。
        </p>
      </div>
    </main>
  );
}
