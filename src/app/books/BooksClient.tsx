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

type BookProgress = {
  target_key: string;
  section_index: number | null;
  total_sections: number | null;
  progress_percent: number | null;
  completed_section_index: number | null;
  completed_progress_percent: number | null;
  updated_at: string | null;
};

const books: BookShelfItem[] = [
  {
    no: 1,
    target_key: 'mu_book_1',
    course_id: 2,
    title: 'イマジナルフィールドの法則',
    subtitle: 'もうひとつのわたし、Mu',
    direction: '願っている未来と、実際に見ている未来のズレから始まる巻。みゆがMuと出会い、イマジナルという入口を開きます。',
    core: '人は、願いではなく、いま見えている未来に反応している。',
  },
  {
    no: 2,
    target_key: 'mu_book_2',
    course_id: 3,
    title: '願いは、反対へ歩いていた',
    subtitle: '叶わない願いの秘密',
    direction: '願いと方向のズレを描く巻。自由を願いながら、怖い未来を避けるために同じ現実へ戻っていたことに気づきます。',
    core: '願いは、叶えるものではなく、向きを知る入口だった。',
  },
  {
    no: 3,
    target_key: 'mu_book_3',
    course_id: 4,
    title: '君に合わせて、わたしが消えた',
    subtitle: '愛とすれ違いの物語',
    direction: '恋愛や関係性の中で、イマジナルがどのように言葉と行動を変えるのかを描く巻。愛されたいほど、自分を後回しにしていた構造を見つめます。',
    core: '愛されたい私は、いつから私を消していたのだろう。',
  },
  {
    no: 4,
    target_key: 'mu_book_4',
    course_id: 5,
    title: '置き去りにされた、もうひとつの私',
    subtitle: '私を縛っていた景色',
    direction: '外から置かれた未来と、自分の内面から生まれる未来を見分けていく巻。不自由の形象を見つめます。',
    core: '私は、もうひとつの私を置き去りにしていた。',
  },
  {
    no: 5,
    target_key: 'mu_book_5',
    course_id: 6,
    title: '黒い流れが、光へ戻る日',
    subtitle: '不安から創造へ',
    direction: '不安・比較・欠乏へ流れていた力が、創造の方向へ戻る巻。仕事やビジネスの見え方が変わります。',
    core: '人は、力を失ったのではない。その力の向きを、忘れていただけだった。',
  },
  {
    no: 6,
    target_key: 'mu_book_6',
    course_id: 7,
    title: '未来が、言葉を呼んでいた',
    subtitle: '身・口・意の叡智',
    direction: '未来の形象が先にあり、そこから言葉が生まれ、行動が動き出す巻。イマジン三形象の入口を開きます。',
    core: '言葉が未来を作るのではない。先に立ち上がった未来が、言葉を呼んでいた。',
  },
  {
    no: 7,
    target_key: 'mu_book_7',
    course_id: 8,
    title: '形象は、フィールドで出現する',
    subtitle: '場と創造の法則',
    direction: '形象が現実に現れるためには、フィールドが必要だと分かる巻。Muverseが、形象を育てる場として見えてきます。',
    core: 'Muverseとは、形象が出現するフィールドである。',
  },
  {
    no: 8,
    target_key: 'mu_book_8',
    course_id: 9,
    title: '私は、まだ私に会っていなかった',
    subtitle: 'もうひとつのわたしの記憶',
    direction: 'Muの正体と、「もうひとつのわたし」の記憶が開き始める巻。外に預けていた叡智が、自分の内面へ還っていきます。',
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
    direction: 'みゆの物語が、読者自身へ反転する巻。読んでいた物語が、自分のイマジナルフィールドの入口へ変わります。',
    core: 'みゆの物語は終わった。でも、あなたの物語はここから始まる。',
  },
];

const planText: Record<string, string> = {
  free: 'Free：法則の入口となる第1巻の無料ページのみ。Moodle入場は有料プランからです。',
  regular: 'Regular：今月選択した1巻だけ読めます。選んだ巻が、今月の学びの扉になります。',
  premium: 'Premium：全巻を読めます。イマジナルフィールドの流れに沿って進めます。',
  master: 'Master：全巻とセッション対象です。読むことから、対話と実践へつなげます。',
  partner: 'Partner：全巻と講座対象です。学びを場へ広げる導線が開きます。',
  admin: 'Admin：全巻対象です。Moodle管理者権限はSSOでは渡しません。',
};

function normalizePlan(value: unknown) {
  const plan = String(value || 'free').toLowerCase();
  return ['free', 'regular', 'premium', 'master', 'partner', 'admin'].includes(plan) ? plan : 'free';
}

function toNumberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function formatPercent(value: number) {
  if (value <= 0) return '0%';
  if (value >= 99.95) return '100%';
  return `${Math.round(value * 10) / 10}%`;
}

function formatCompletedLabel(completedSectionIndex: number | null, progressPercent: number) {
  if (!completedSectionIndex || completedSectionIndex <= 0) return '未読';
  if (progressPercent >= 99.95) return '完読';

  const chapterNo = Math.floor((completedSectionIndex - 1) / 3) + 1;
  const sectionNo = ((completedSectionIndex - 1) % 3) + 1;

  return `第${chapterNo}章${sectionNo}節まで完了`;
}

function normalizeBookmark(raw: any, targetKey: string): BookProgress | null {
  if (!raw) return null;

  return {
    target_key: targetKey,
    section_index: toNumberOrNull(raw.section_index),
    total_sections: toNumberOrNull(raw.total_sections),
    progress_percent: toNumberOrNull(raw.progress_percent),
    completed_section_index: toNumberOrNull(raw.completed_section_index),
    completed_progress_percent: toNumberOrNull(raw.completed_progress_percent),
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
  };
}

export default function BooksClient() {
  const { loading, user, planStatus } = useAuth();
  const [serverPlan, setServerPlan] = useState<string>('');
  const [progressByTargetKey, setProgressByTargetKey] = useState<Record<string, BookProgress>>({});
  const [progressLoading, setProgressLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const plan = normalizePlan(serverPlan || planStatus);

  useEffect(() => {
    if (!user) {
      setServerPlan('');
      setProgressByTargetKey({});
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

  useEffect(() => {
    if (!user) {
      setProgressByTargetKey({});
      return;
    }

    let alive = true;
    setProgressLoading(true);

    Promise.all(
      books.map(async (book) => {
        try {
          const res = await authedFetch(`/api/moodle/bookmark?target_key=${encodeURIComponent(book.target_key)}`);
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data?.ok || !data?.found || !data?.bookmark) return null;
          return normalizeBookmark(data.bookmark, book.target_key);
        } catch {
          return null;
        }
      })
    )
      .then((items) => {
        if (!alive) return;

        const next: Record<string, BookProgress> = {};
        items.forEach((item) => {
          if (item) next[item.target_key] = item;
        });
        setProgressByTargetKey(next);
      })
      .finally(() => {
        if (alive) setProgressLoading(false);
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
          <div className={styles.eyebrow}>Imaginal Field Reading</div>
          <h1 className={styles.title}>
            Mu BOOK
            <span>イマジナルフィールドの本棚</span>
          </h1>
          <p className={styles.lead}>
            読むことは、答えを集めることではありません。あなたが見ている未来に気づき、
            その形象を言葉と行動へ移し、創造の方向へ戻していく入口です。
          </p>
        </section>

        <section className={styles.statusCard}>
          <div>
            <span className={styles.statusLabel}>この本棚について</span>
            <strong className={styles.statusValue}>イマジナルフィールドの法則</strong>
          </div>
          <p className={styles.statusText}>
            願っている未来と、実際に見ている未来は同じとは限りません。
            Mu BOOKでは、物語・音声・Muとの対話を通して、外から置かれた未来ではなく、
            あなたの内面から生まれる未来の形象を見つけていきます。
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

        <section className={styles.grid} aria-label="Mu BOOK イマジナルフィールドの本棚">
          {books.map((book) => {
            const progress = progressByTargetKey[book.target_key] || null;
            const completedPercent = clampPercent(progress?.completed_progress_percent);
            const completedSectionIndex = toNumberOrNull(progress?.completed_section_index);
            const progressLabel = formatCompletedLabel(completedSectionIndex, completedPercent);
            const percentLabel = progressLoading ? '読込中' : formatPercent(completedPercent);

            return (
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

                <div className={styles.progressBox} aria-label={`第${book.no}巻の読書進捗`}>
                  <div className={styles.progressHeader}>
                    <span>正式進捗</span>
                    <strong>{percentLabel}</strong>
                  </div>
                  <div className={styles.progressTrack} aria-hidden="true">
                    <div
                      className={styles.progressFill}
                      style={{ width: progressLoading ? '0%' : `${completedPercent}%` }}
                    />
                  </div>
                  <p className={styles.progressText}>{progressLoading ? '進捗を確認しています...' : progressLabel}</p>
                </div>

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
            );
          })}
        </section>

        <p className={styles.footerHint}>
          Freeは無料ページへ。Regularは今月選んだ1巻へ。Premium以上は全巻へ。
          権限の最終判定は、入場時にMuverse側で行います。
        </p>
      </div>
    </main>
  );
}
