// src/app/knowledge/KnowledgeClient.tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import styles from './KnowledgePage.module.css';

type Action = { href: string; label: string };
type Item = {
  area: string;
  intent: string;
  title: string;
  content: string;
  actions: Action[] | null;
  tags: string[] | null;
};

export default function KnowledgeClient() {
  const router = useRouter();
  const sp = useSearchParams();
  const initialQ = sp.get('q') ?? '';

  const [q, setQ] = useState(initialQ);
  const [toc, setToc] = useState<{ area: string; titles: string[] }[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Item | null>(null);
  const [loading, setLoading] = useState(false);
  const [tocOpen, setTocOpen] = useState(false); // 目次ドロワーの開閉

  useEffect(() => {
    fetch('/api/knowledge/toc')
      .then((r) => r.json())
      .then((d) => setToc(d.items ?? []));
  }, []);

  useEffect(() => {
    if (initialQ) handleSearch(initialQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSearch(input?: string) {
    const keyword = (input ?? q).trim();
    if (!keyword) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/knowledge/search?q=${encodeURIComponent(keyword)}`);
      const data = await res.json();
      setItems(data.items ?? []);
      setSelected(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadByTitle(title: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/knowledge/get?title=${encodeURIComponent(title)}`);
      const data = await res.json();
      setSelected(data.item ?? null);
      setItems([]);
      setTocOpen(false); // モバイルで選択後は閉じる
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`${styles.container} ${tocOpen ? styles.isDrawerOpen : ''}`}>
      {/* ヘッダー */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button className={styles.backBtn} onClick={() => router.back()} aria-label="戻る">
            ← 戻る
          </button>
          <h1 className={styles.title}>Q&amp;A ナレッジ</h1>
          <span className={styles.badgeFree}>無料</span>
        </div>

        {/* ハンバーガー（常時表示でも可） */}
        <button
          className={styles.menuBtn}
          aria-label="目次を開く"
          aria-expanded={tocOpen}
          onClick={() => setTocOpen(true)}
        >
          <span className={styles.menuIcon} aria-hidden="true" />
        </button>
      </div>

      {/* 検索 */}
      <div className={styles.search}>
        <input
          className={styles.searchInput}
          placeholder="キーワード検索（例: Vision / クレジット / Board）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <button className={styles.searchBtn} onClick={() => handleSearch()}>
          検索
        </button>
      </div>

      <div className={styles.layout}>
        {/* 左の固定目次：ドロワー開時は確実に非表示 */}
        <aside className={styles.tocDesktop} style={{ display: tocOpen ? 'none' : undefined }}>
          {toc.map((sec, i) => (
            <details key={i} className={styles.tocSection} open={i === 0}>
              <summary className={styles.tocSummary}>{sec.area}</summary>
              <ul className={styles.tocList}>
                {sec.titles.map((t, idx) => (
                  <li key={idx}>
                    <button className={styles.tocItemBtn} onClick={() => loadByTitle(t)}>
                      {t}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </aside>

        {/* 回答エリア */}
        <main className={styles.answer}>
          {loading && <p className={styles.muted}>読み込み中…</p>}
          {!loading && selected && <AnswerCard item={selected} />}
          {!loading && !selected && items.length > 0 && (
            <div className={styles.cardList}>
              {items.map((it, i) => (
                <AnswerCard key={`${it.title}-${i}`} item={it} />
              ))}
            </div>
          )}
          {!loading && !selected && items.length === 0 && (
            <p className={styles.muted}>左の目次から選ぶか、検索してください。</p>
          )}
        </main>
      </div>

      {/* ドロワー（モバイル/PC共用） */}
      <div
        className={`${styles.drawer} ${tocOpen ? styles.drawerOpen : ''}`}
        role="dialog"
        aria-modal="true"
      >
        <div className={styles.drawerHeader}>
          <div className={styles.drawerTitle}>目次</div>
          <button
            className={styles.drawerClose}
            onClick={() => setTocOpen(false)}
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>
        <div className={styles.drawerBody}>
          {toc.map((sec, i) => (
            <details key={i} className={styles.tocSection} open={i === 0}>
              <summary className={styles.tocSummary}>{sec.area}</summary>
              <ul className={styles.tocList}>
                {sec.titles.map((t, idx) => (
                  <li key={idx}>
                    <button
                      className={styles.tocItemBtn}
                      onClick={() => {
                        loadByTitle(t);
                        setTocOpen(false);
                      }}
                    >
                      {t}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      </div>

      {/* 背景オーバーレイ */}
      {tocOpen && <div className={styles.overlay} onClick={() => setTocOpen(false)} />}
    </div>
  );
}

function AnswerCard({ item }: { item: Item }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardTitle}>{item.title}</div>
      <p className={styles.cardText}>{item.content}</p>
      {Array.isArray(item.actions) && item.actions.length > 0 && (
        <div className={styles.cardActions}>
          {item.actions.map((a, i) => (
            <a key={i} href={a.href} className={styles.cardLink}>
              {a.label}
            </a>
          ))}
        </div>
      )}
      {Array.isArray(item.tags) && item.tags.length > 0 && (
        <div className={styles.tags}>タグ: {item.tags.join(' / ')}</div>
      )}
    </div>
  );
}
