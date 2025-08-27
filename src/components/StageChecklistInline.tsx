'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Stage } from '@/types/vision';

type Props = {
  visionId: string;
  from: Stage;
  showActions?: boolean;        // 操作ボタンの表示
  variant?: 'seed' | 'mid' | 'late' | 'success' | 'alert'; // 色分け（任意）
  className?: string;           // 追加クラス（任意）
  /** ← 追加：ビジョンの現在ステータスを小さく表示（任意） */
  visionStatus?: VisionStatus | null;
};

type Criteria = {
  id: string;
  required_days: number;
  achieved_days: number; // APIの done_days を反映
};

/** ステータス型（任意で受け取れる） */
type VisionStatus =
  | '検討中'
  | '実践中'
  | '迷走中'
  | '順調'
  | 'ラストスパート'
  | '達成'
  | '破棄';

export default function StageChecklistInline({
  visionId,
  from,
  showActions = false,
  variant = 'seed',
  className,
  visionStatus, // ★ 追加
}: Props) {
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
        const achieved = Number(
          data?.done_days ?? data?.achieved_days ?? data?.progress?.streak ?? 0
        );
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

  useEffect(() => {
    fetchCriteria();
  }, [visionId, from]);

  // DailyCheckPanel 等からの反映
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        visionId: string;
        from: Stage;
        required_days: number;
      };
      if (d?.visionId === visionId && d?.from === from) {
        setCriteria((prev) =>
          prev
            ? { ...prev, required_days: d.required_days }
            : { id: `${visionId}:${from}`, required_days: d.required_days, achieved_days: 0 }
        );
      }
    };
    window.addEventListener('vision:criteria-updated', handler as EventListener);
    return () =>
      window.removeEventListener('vision:criteria-updated', handler as EventListener);
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
        body: JSON.stringify({
          vision_id: visionId,
          from,
          required_days: 3,
          checklist: [],
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchCriteria();
    } catch (e) {
      console.error(e);
    }
  }

  // ---- 表示値 ----
  const req = criteria?.required_days ?? 0;
  const done = criteria?.achieved_days ?? 0;
  const ratio = useMemo(
    () => Math.min(1, Math.max(0, req ? done / req : 0)),
    [req, done]
  );
  const reached = req > 0 && done >= req;

  return (
    <div
      className={[
        'sci-wrap',
        `sci--${variant}`,
        reached ? 'is-reached' : '',
        className || '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {loading && <div className="sci-row">読み込み中…</div>}
      {!loading && error && <div className="sci-row sci-err">読み込みエラー：{error}</div>}

      {!loading && !error && (
        <>
          {criteria ? (
            <div className="sci-block">
              <div className="sci-head">
                <span className="sci-sub">習慣ゲージ</span>

                {/* ★ 追加：ビジョンの現在ステータス（小さなバッジ）。CSS で色付け可 */}
                {visionStatus ? (
                  <span
                    className="sci-vstatus"
                    data-vs={visionStatus}
                    title="現在のステータス"
                  >
                    {visionStatus}
                  </span>
                ) : null}

                <span className={`sci-badge ${reached ? 'ok' : 'wip'}`}>
                  {reached ? '達成' : '進行中'}
                </span>
              </div>

              <div
                className="sci-gauge"
                role="progressbar"
                aria-label="習慣ゲージ"
                aria-valuemin={0}
                aria-valuemax={req}
                aria-valuenow={done}
              >
                <div className="sci-gauge__bar" style={{ width: `${ratio * 100}%` }} />
              </div>

              {/* 1行表記 */}
              <div className="sci-line">
                必要 {req} / 達成 {done}
              </div>

              {/* 達成演出 */}
              {reached && (
                <>
                  <div className="sci-glow" aria-hidden />
                  <div className="sci-confetti" aria-hidden />
                </>
              )}
            </div>
          ) : (
            <div className="sci-row">（橋渡し基準が未作成）</div>
          )}

          {showActions && (
            <div className="sci-actions">
              <button onClick={fetchCriteria}>再読み込み</button>
              <button onClick={createDefault}>デフォルトを作成</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
