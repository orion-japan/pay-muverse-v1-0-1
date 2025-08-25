'use client';

import { useEffect, useState, useCallback } from 'react';
import type { Stage } from '@/types/vision';

type Row = {
  id: string;
  vision_id: string;
  from_stage: Stage;
  to_stage: Stage | null;
  title: string;
  required_days: number | null;
  done_days: number | null;
};

export default function StageChecklistInline({
  visionId,
  from,
}: {
  visionId: string;
  from: Stage;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const getToken = useCallback(async () => {
    const { getAuth, signInAnonymously } = await import('firebase/auth');
    const auth = getAuth();
    if (!auth.currentUser) await signInAnonymously(auth);
    return auth.currentUser!.getIdToken();
  }, []);

  const fetchRows = useCallback(async () => {
    try {
      setLoading(true);
      setErr(null);
      const token = await getToken();
      const res = await fetch(
        `/api/vision-criteria?vision_id=${encodeURIComponent(visionId)}&from=${from}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setRows(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setErr(e.message || String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [visionId, from, getToken]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  const seedDefaults = async (ev?: React.MouseEvent) => {
    ev?.stopPropagation?.();
    try {
      setLoading(true);
      setErr(null);
      const token = await getToken();
      const res = await fetch('/api/vision-criteria', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ seed: true, vision_id: visionId, from }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setRows(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const tickToday = async (id: string, ev?: React.MouseEvent) => {
    ev?.stopPropagation?.();
    try {
      const token = await getToken();
      const res = await fetch('/api/vision-criteria', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id, op: 'inc' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setRows(prev => prev?.map(r => (r.id === id ? data : r)) ?? []);
    } catch (e: any) {
      setErr(e.message || String(e));
    }
  };

  if (loading && rows === null) return <div className="vc-bridge">読み込み中…</div>;

  if (err) {
    return (
      <div className="vc-bridge error" onClick={e => e.stopPropagation()}>
        読み込みエラー：{JSON.stringify({ error: err })}
        <button
          className="vc-link"
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); fetchRows(); }}
        >
          再読み込み
        </button>
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <div className="vc-bridge empty" onClick={e => e.stopPropagation()}>
        次の段へ進むためのチェックリストは未設定です。{' '}
        <button
          className="vc-link"
          onMouseDown={e => e.stopPropagation()}
          onClick={seedDefaults}
        >
          デフォルトを作成
        </button>
      </div>
    );
  }

  return (
    <div className="vc-bridge" onClick={e => e.stopPropagation()}>
      {rows.map(r => {
        const req = Math.max(1, r.required_days ?? 1);
        const done = Math.min(req, r.done_days ?? 0);
        const doneAll = done >= req;
        return (
          <div key={r.id} className="vc-row">
            <button
              className={`vc-check ${doneAll ? 'is-done' : ''}`}
              title="今日の一手 ✓"
              onMouseDown={e => e.stopPropagation()}
              onClick={e => tickToday(r.id, e)}
            >
              ✓
            </button>
            <div className="vc-meta">
              <div className="vc-title">{r.title}</div>
              <div className="vc-progress">{done}/{req} 日</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
