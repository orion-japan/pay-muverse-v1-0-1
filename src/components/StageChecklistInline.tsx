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
  achieved_days: number;   // ← 表示用（＝APIの done_days）
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

      const res = await fetch(
        `/api/vision-criteria?vision_id=${encodeURIComponent(visionId)}&from=${from}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `status ${res.status}`);
      }
      const data = await res.json();

      if (!data) {
        setCriteria(null);
      } else {
        // APIのdone_daysを優先、無ければ後方互換（progress?.streak等）
        const achieved =
          Number(data?.done_days ?? data?.achieved_days ?? data?.progress?.streak ?? 0);

        setCriteria({
          id: data.id ?? `${visionId}:${from}`,
          required_days: Number(data.required_days ?? 3),
          achieved_days: achieved,
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

  // DailyCheckPanel で回数を保存した直後に即時反映するためのイベントフック
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        visionId: string; from: Stage; required_days: number;
      };
      if (d?.visionId === visionId && d?.from === from) {
        setCriteria(prev => prev
          ? { ...prev, required_days: d.required_days }
          : { id: `${visionId}:${from}`, required_days: d.required_days, achieved_days: 0 }
        );
      }
    };
    window.addEventListener('vision:criteria-updated', handler as EventListener);
    return () => window.removeEventListener('vision:criteria-updated', handler as EventListener);
  }, [visionId, from]);

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
