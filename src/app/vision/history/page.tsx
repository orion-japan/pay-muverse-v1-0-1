// src/app/vision/history/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';   // ← 追加
import './history.css';

type HistItem = {
  vision_id: string;
  title: string | null;
  status: '達成' | '保留' | '意図チェンジ' | '破棄';
  phase: 'initial' | 'mid' | 'final';
  ended_at: string | null;
  q_code?: string | null;
  supersedes_vision_id?: string | null;
  superseded_by_id?: string | null;
  iboard_thumb?: string | null;
};

export default function HistoryPage() {
  const router = useRouter();   // ← 追加
  const [tab, setTab] = useState<'達成' | '意図チェンジ' | '保留'>('達成');
  const [items, setItems] = useState<HistItem[]>([]);
  const [loading, setLoading] = useState(true);

  const userCode =
    typeof window !== 'undefined'
      ? localStorage.getItem('user_code') || ''
      : '';

  async function load() {
    setLoading(true);
    const res = await fetch(`/api/visions/history?status=${encodeURIComponent(tab)}`, {
      headers: userCode ? { 'x-user-code': userCode } : undefined,
    });
    if (!res.ok) {
      setItems([]);
      setLoading(false);
      return;
    }
    const json = await res.json();
    setItems(Array.isArray(json) ? json : json.items || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, [tab]);

  return (
    <div className="vh-wrap">
      <div className="vh-header">
        <h2>履歴</h2>

        {/* ✅ 戻るボタン追加 */}
        <button
          className="vh-back"
          onClick={() => router.push('/vision')}
        >
          ← 戻る
        </button>

        <div className="vh-tabs">
          {(['達成','意図チェンジ','保留'] as const).map(s => (
            <button key={s} className={tab===s?'is-active':''} onClick={()=>setTab(s)}>{s}</button>
          ))}
        </div>
      </div>

      {loading ? <p>読み込み中…</p> : (
        <div className="vh-grid">
          {items.length === 0 && <div className="vh-empty">該当なし</div>}
          {items.map(it => (
            <article key={it.vision_id} className={`vh-card s-${it.status}`}>
              {it.iboard_thumb && (
                <div className="vh-thumb"><img src={it.iboard_thumb} alt="" /></div>
              )}
              <div className="vh-body">
                <div className="vh-top">
                  <span className="vh-badge">{it.status}</span>
                  {it.q_code && <span className="vh-q">Q:{it.q_code}</span>}
                  {it.ended_at && (
                    <span className="vh-date">{new Date(it.ended_at).toLocaleDateString()}</span>
                  )}
                </div>
                <h3 className="vh-title">{it.title || '(無題)'}</h3>
                <div className="vh-links">
                  {it.supersedes_vision_id && <a href={`/vision/${it.supersedes_vision_id}`}>← 旧を開く</a>}
                  {it.superseded_by_id && <a href={`/vision/${it.superseded_by_id}`}>→ 新を開く</a>}
                </div>
                <div className="vh-actions">
                  {it.status === '保留' && <a href={`/vision/${it.vision_id}?resume=1`}>再開する</a>}
                  {it.status === '達成' && <a href={`/vision/${it.vision_id}`}>詳細を見る</a>}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
