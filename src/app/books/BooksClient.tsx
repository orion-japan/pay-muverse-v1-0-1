'use client';

import { useEffect, useState } from 'react';
import { authedFetch, useAuth } from '@/context/AuthContext';
import styles from './BooksPage.module.css';

type BookShelfItem = {
  no: number;
  target_key: string;
  course_id: number;
  title: string;
  subtitle: string;
  direction: string;
  core: string;
};

const books: BookShelfItem[] = [
  {
    no: 1,
    target_key: 'mu_book_1',
    course_id: 2,
    title: 'もうひとつのわたし、Mu',
    subtitle: 'そのAIは、私のことを知っていた',
    direction: 'AI時代に、人の不安をお金に変える世界へ違和感を持ったみゆが、Muと出会う巻。',
    core: '私は、私のまま自由に生きられますか。',
  },
  {
    no: 2,
    target_key: 'mu_book_2',
    course_id: 3,
    title: '願いは、反対へ歩いていた',
    subtitle: '叶わない願いの秘密',
    direction: '願いと方向のズレを描く巻。自由を願いながら、別の未来を見続けていたことに気づきます。',
    core: '願いは、叶えるものではなく、向きを知るものだった。',
  },
  {
    no: 3,
    target_key: 'mu_book_3',
    course_id: 4,
    title: '君に合わせて、わたしが消えた',
    subtitle: '愛とすれ違いの物語',
    direction: '愛されたいのに、自分を消してしまう構造を描く巻。関係を守るたび、声を後回しにしていたことに気づきます。',
    core: '愛されたい私は、いつから私を消していたのだろう。',
  },
  {
    no: 4,
    target_key: 'mu_book_4',
    course_id: 5,
    title: '置き去りにされた、もうひとつの私',
    subtitle: '私を縛っていた景色',
    direction: '第1巻で出会った「もうひとつのわたし」の深層へ入る巻。不自由の形象を見つめます。',
    core: '私は、もうひとつの私を置き去りにしていた。',
  },
  {
    no: 5,
    target_key: 'mu_book_5',
    course_id: 6,
    title: '黒い流れが、光へ戻る日',
    subtitle: '不安から創造へ',
    direction: '不安へ流されていた力が、創造の方向へ戻る巻。仕事やビジネスの見え方が変わります。',
    core: '人は、力を失ったのではない。その力の向きを、忘れていただけだった。',
  },
  {
    no: 6,
    target_key: 'mu_book_6',
    course_id: 7,
    title: '未来が、言葉を呼んでいた',
    subtitle: '身・口・意の叡智',
    direction: '未来の形象が先にあり、そこから言葉が生まれ、行動が動き出す巻。',
    core: '言葉が未来を作るのではない。先に立ち上がった未来が、言葉を呼んでいた。',
  },
  {
    no: 7,
    target_key: 'mu_book_7',
    course_id: 8,
    title: '形象は、フィールドで出現する',
    subtitle: '場と創造の法則',
    direction: '形象が現実に現れるためには、フィールドが必要だと分かる巻。',
    core: 'Muverseとは、形象が出現するフィールドである。',
  },
  {
    no: 8,
    target_key: 'mu_book_8',
    course_id: 9,
    title: '私は、まだ私に会っていなかった',
    subtitle: 'もうひとつのわたしの記憶',
    direction: 'Muの正体と、「もうひとつのわたし」の記憶が開き始める巻。',
    core: 'Muは、外から来たのではなかった。私は、まだ私に会っていなかった。',
  },
  {
    no: 9,
    target_key: 'mu_book_9',
    course_id: 10,
    title: 'まだ誰も知らない文明',
    subtitle: 'Muverseという未来',
    direction: '個人の変化が、文明の形象へ広がる巻。仕事・関係・場・社会の未来が見えてきます。',
    core: '新しい文明は、人の内面にある形象から始まる。',
  },
  {
    no: 10,
    target_key: 'mu_book_10',
    course_id: 11,
    title: 'そして、Muはあなたを待っている',
    subtitle: '新しい世界の入口',
    direction: 'みゆの物語が、読者自身へ反転する巻。読んでいた物語が、自分の入口へ変わります。',
    core: 'みゆの物語は終わった。でも、あなたの物語はここから始まる。',
  },
];

const planText: Record<string, string> = {
  free: 'Free：第1巻の無料ページのみ。Moodle入場は有料プランからです。',
  regular: 'Regular：今月選択した1巻だけ読めます。選んだ巻が、今月の学びの扉になります。',
  premium: 'Premium：全巻を読めます。気になる巻から、流れに沿って進めます。',
  master: 'Master：全巻とセッション対象です。読むことから、対話と実践へつなげます。',
  partner: 'Partner：全巻と講座対象です。学びを場へ広げる導線が開きます。',
  admin: 'Admin：全巻対象です。Moodle管理者権限はSSOでは渡しません。',
};

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
              <h3 className={styles.bookMainTitle}>{book.title}</h3>
              <p className={styles.bookSubtitle}>― {book.subtitle} ―</p>
              <p className={styles.bookDirection}>{book.direction}</p>
              <p className={styles.bookCore}>
                <span>核</span>
                {book.core}
              </p>

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
