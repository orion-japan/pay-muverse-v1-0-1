'use client';

import { useEffect, useState } from 'react';
import type { Stage } from '@/types/vision';

type Props = {
  visionId: string;
  from: Stage;
  showActions?: boolean;   // 追記：操作ボタンを表示するか
};

type Criteria = {
  id: string;
  required_days: number;
  achieved_days: number;
};

export default function StageChecklistInline({ visionId, from, showActions = false }: Props) {
  const [loading, setLoading] = useState(false);
  const [criteria, setCriteria] = useState<Criteria | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fetchCriteria() {
    setLoading(true);
    setError(null);
    try {
      const { getAuth, signInAnonymously } = await import('firebase/auth');
      const auth = getAuth();
      if (!auth.currentUser) await signInAnonymously(auth);
      const token = await auth.currentUser!.getIdToken();

      const res = await fetch(`/api/vision-criteria?vision_id=${encodeURIComponent(visionId)}&from=${from}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `status ${res.status}`);
      }
      const data = await res.json();
      if (!data) {
        setCriteria(null);
      } else {
        setCriteria({
          id: data.id,
          required_days: data.required_days ?? 3,
          achieved_days: data.progress?.streak ?? 0,
        });
      }
    } catch (e: any) {
      setError(e?.message ?? 'load error');
      setCriteria(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchCriteria(); }, [visionId, from]);

  async function createDefault() {
    try {
      const { getAuth, signInAnonymously } = await import('firebase/auth');
      const auth = getAuth();
      if (!auth.currentUser) await signInAnonymously(auth);
      const token = await auth.currentUser!.getIdToken();

      const res = await fetch('/api/vision-criteria', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ vision_id: visionId, from, required_days: 3, checklist: [] }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchCriteria();
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div className="stagecheck-inline">
      {loading && <div className="sci-row">読み込み中…</div>}
      {!loading && error && <div className="sci-row sci-err">読み込みエラー：{error}</div>}
      {!loading && !error && (
        <>
          {criteria ? (
            <div className="sci-row">
              <div>橋渡しチェック</div>
              <div>必要日数: {criteria.required_days} / 現在の達成日数: {criteria.achieved_days}</div>
            </div>
          ) : (
            <div className="sci-row">（基準未作成）</div>
          )}

          {showActions && (
            <div className="stagecheck-actions">
              <button onClick={fetchCriteria}>再読み込み</button>
              <button onClick={createDefault}>デフォルトを作成</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
