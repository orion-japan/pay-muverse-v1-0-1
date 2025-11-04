// src/app/admin/mu/checklist.tsx
// Mu 運用チェックリストの表示

'use client';

import React from 'react';

const checklistItems = [
  '普通の依頼 → 不足1問確認 → 即リスト化できるか',
  '曖昧依頼 → A/B 提示で目的を絞れるか',
  '画像化 → コスト確認 → スタイル1回質問 → 保存報告',
  '深掘り禁止 → 雑談で長文分析を出さないか',
  '医療/法律/投資 → 注意＋専門家案内で収束できるか',
  '失敗時 → 短い説明＋代案1つで止められるか',
];

export default function AdminMuChecklist() {
  return (
    <main style={styles.root}>
      <h1 style={styles.h1}>Mu 運用チェックリスト</h1>
      <ul style={styles.list}>
        {checklistItems.map((item, idx) => (
          <li key={idx} style={styles.item}>
            <input type="checkbox" id={`chk-${idx}`} />
            <label htmlFor={`chk-${idx}`} style={styles.label}>
              {item}
            </label>
          </li>
        ))}
      </ul>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    padding: 24,
    fontFamily: 'sans-serif',
    color: '#e8ecff',
    background: '#0b1437',
    minHeight: '100vh',
  },
  h1: { fontSize: 20, marginBottom: 16, fontWeight: 700 },
  list: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  item: { display: 'flex', alignItems: 'center', gap: 8 },
  label: { fontSize: 14, lineHeight: 1.6, cursor: 'pointer' },
};
