// src/app/vision/history/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase'; // album:// 署名URL解決に使用
import './history.css';

type HistItem = {
  vision_id: string;
  title: string | null;
  status: string | null;
  phase: 'initial' | 'mid' | 'final' | null;
  moved_to_history_at?: string | null;
  archived_at?: string | null;
  q_code?: any;                 // ← 文字列 or オブジェクト
  iboard_thumb?: string | null; // album:// or direct URL
  supersedes_vision_id?: string | null;
  superseded_by_id?: string | null;
};

// ===== ユーティリティ =====
function toSafeQString(q: any): string | null {
  if (q == null) return null;
  if (typeof q === 'string') return q;
  if (typeof q === 'object' && typeof q.code === 'string') return q.code;
  try { return JSON.stringify(q); } catch { return null; }
}
function fmtDate(iso?: string | null) {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString() : '';
}
const PHASE_LABEL: Record<'initial' | 'mid' | 'final', string> = {
  initial: '初期',
  mid: '中期',
  final: '後期',
};

// サムネイル（album:// → 署名URL解決）
function HistoryThumb({ url }: { url: string }) {
  const [resolved, setResolved] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!url) { if (alive) setResolved(null); return; }
      if (url.startsWith('album://')) {
        try {
          let path = url.replace(/^album:\/\//, '').replace(/^\/+/, '');
          // private-posts/ が重なっても剥がす
          path = path.replace(/^(?:private-posts\/)+/, '');
          const { data, error } = await supabase
            .storage.from('private-posts')
            .createSignedUrl(path, 60 * 60); // 1h
          if (!alive) return;
          setResolved(error ? null : (data?.signedUrl ?? null));
        } catch {
          if (alive) setResolved(null);
        }
      } else {
        if (alive) setResolved(url);
      }
    })();
    return () => { alive = false; };
  }, [url]);

  if (!resolved) return null;
  return (
    <div className="vh-thumb">
      <img src={resolved} alt="" />
    </div>
  );
}

export default function HistoryPage() {
  const router = useRouter();
  const [items, setItems] = useState<HistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null); // ★ 追加: 処理中のカードID

  const userCode =
    typeof window !== 'undefined' ? (localStorage.getItem('user_code') || '') : '';

  async function load() {
    setLoading(true);
    const res = await fetch('/api/visions/history', {
      headers: userCode ? { 'x-user-code': userCode } : undefined,
      cache: 'no-store',
    });
    const json = await res.json().catch(() => ({}));
    setItems(Array.isArray(json) ? json : (json.items || []));
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // ★ 追加: 実践へ戻す
  async function restoreVision(visionId: string) {
    if (!confirm('このビジョンを「実践」に戻します。よろしいですか？')) return;
    setBusyId(visionId);
    try {
      const res = await fetch('/api/visions/unarchive', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(userCode ? { 'x-user-code': userCode } : {}),
        },
        body: JSON.stringify({ vision_id: visionId }),
      });
      if (!res.ok) throw new Error(await res.text());
      // 履歴一覧から除去
      setItems(prev => prev.filter(x => x.vision_id !== visionId));
    } catch (e) {
      console.error(e);
      alert('戻すのに失敗しました');
    } finally {
      setBusyId(null);
    }
  }

  // ★ 追加: 削除
  async function deleteVision(visionId: string) {
    if (!confirm('このビジョンを完全に削除します。元に戻せません。よろしいですか？')) return;
    setBusyId(visionId);
    try {
      const res = await fetch('/api/visions/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(userCode ? { 'x-user-code': userCode } : {}),
        },
        body: JSON.stringify({ vision_id: visionId }),
      });
      if (!res.ok) throw new Error(await res.text());
      // 履歴一覧から除去
      setItems(prev => prev.filter(x => x.vision_id !== visionId));
    } catch (e) {
      console.error(e);
      alert('削除に失敗しました');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="vh-wrap">
      <div className="vh-header">
        <h2>履歴</h2>
        <button className="vh-back" onClick={() => router.push('/vision')}>← 戻る</button>
      </div>

      {loading ? (
        <p>読み込み中…</p>
      ) : (
        <div className="vh-grid">
          {items.length === 0 && <div className="vh-empty">履歴はまだありません</div>}

          {items
            .slice()
            .sort((a, b) => {
              const ta = Date.parse(a.moved_to_history_at || a.archived_at || '') || 0;
              const tb = Date.parse(b.moved_to_history_at || b.archived_at || '') || 0;
              return tb - ta;
            })
            .map((it) => {
              const q = toSafeQString(it.q_code); // ★ ここで必ず文字列化
              const dateStr = fmtDate(it.moved_to_history_at || it.archived_at);
              const disabled = busyId === it.vision_id; // ★ 追加: ボタン無効化
              return (
                <article key={it.vision_id} className="vh-card">
                  {it.iboard_thumb && <HistoryThumb url={it.iboard_thumb} />}

                  <div className="vh-body">
                    <div className="vh-top">
                      <span className="vh-badge">{it.status ?? '不明'}</span>
                      {it.phase && <span className="vh-phase">{PHASE_LABEL[it.phase]}</span>}
                      {q && <span className="vh-q">Q:{q}</span>}
                      {dateStr && <span className="vh-date">{dateStr}</span>}
                    </div>

                    <h3 className="vh-title">{it.title || '(無題)'}</h3>

                    <div className="vh-links">
                      {it.supersedes_vision_id && (
                        <a href={`/vision/${it.supersedes_vision_id}`}>← 旧を開く</a>
                      )}
                      {it.superseded_by_id && (
                        <a href={`/vision/${it.superseded_by_id}`}>→ 新を開く</a>
                      )}
                    </div>

                    {/* ★ 追加: アクション行（構造は維持しつつ末尾に追加） */}
                    <div className="vh-actions" style={{ marginTop: '.5rem', display: 'flex', gap: '.5rem' }}>
                      <button
                        className="vh-btn"
                        disabled={disabled}
                        onClick={() => restoreVision(it.vision_id)}
                        aria-label="実践に戻す"
                      >
                        実践に戻す
                      </button>
                      <button
                        className="vh-btn danger"
                        disabled={disabled}
                        onClick={() => deleteVision(it.vision_id)}
                        aria-label="削除"
                      >
                        削除
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
        </div>
      )}
    </div>
  );
}
