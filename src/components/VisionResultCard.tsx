'use client';

import { useEffect, useMemo, useState } from 'react';

type PhaseKey = 'initial' | 'mid' | 'final';
type ResultStatus = '成功' | '中断' | '意図違い';

const AUTO_DAYS: Record<PhaseKey, number> = { initial: 7, mid: 14, final: 21 };

export type VisionResultCardProps = {
  visionId: string;
  title: string;
  phase: PhaseKey;
  resultStatus: ResultStatus;
  resultedAt: string;                 // ISO
  userCode: string;                   // x-user-code ヘッダ用
  qCode?: string | null;              // バッジ表示用
  thumbnailUrl?: string | null;       // サムネがあれば表示
  onChanged?: () => void;             // 成功時のリフレッシュコールバック
  className?: string;
};

export default function VisionResultCard({
  visionId,
  title,
  phase,
  resultStatus,
  resultedAt,
  userCode,
  qCode,
  thumbnailUrl,
  onChanged,
  className,
}: VisionResultCardProps) {
  const [busy, setBusy] = useState(false);

  // 残り日数と進捗割合（自動移管まで）
  const { remainingDays, ratio, due } = useMemo(() => {
    const limit = AUTO_DAYS[phase] ?? 7;
    const base = new Date(resultedAt).getTime();
    const elapsedMs = Date.now() - base;
    const totalMs = limit * 24 * 60 * 60 * 1000;
    const leftMs = Math.max(0, totalMs - elapsedMs);
    const remaining = Math.ceil(leftMs / (1000 * 60 * 60 * 24));
    const r = Math.min(1, Math.max(0, elapsedMs / totalMs));
    return { remainingDays: remaining, ratio: r, due: leftMs <= 0 };
  }, [phase, resultedAt]);

  async function post(url: string, body: any) {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-code': userCode,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      onChanged?.();
    } catch (e) {
      console.error('[VisionResultCard] request failed:', e);
      alert('処理に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  // 結果解除（再開）
  const handleResume = () =>
    post('/api/visions/result', { vision_id: visionId, result_status: null });

  // 手動で履歴へ
  const handleArchive = () =>
    post('/api/visions/archive', { vision_id: visionId });

  return (
    <article
      className={[
        'vrc',
        `vrc--${phase}`,
        `vrc-status--${resultStatus}`,
        due ? 'is-due' : '',
        className || '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-labelledby={`vrc-title-${visionId}`}
    >
      {/* サムネ */}
      {thumbnailUrl ? (
        <div className="vrc-thumb">
          <img src={thumbnailUrl} alt="" />
        </div>
      ) : (
        <div className="vrc-thumb vrc-thumb--ph">No Image</div>
      )}

      {/* 本体 */}
      <div className="vrc-body">
        <div className="vrc-top">
          <span className="vrc-badge">{resultStatus}</span>
          {qCode && <span className="vrc-q">Q:{qCode}</span>}
          <span className="vrc-phase">{labelPhase(phase)}</span>
        </div>

        <h3 id={`vrc-title-${visionId}`} className="vrc-title">
          {title || '(無題)'}
        </h3>

        {/* 自動移管までのガイドバー */}
        <div className="vrc-rail" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio*100)}>
          <div className="vrc-rail__bar" style={{ width: `${ratio * 100}%` }} />
        </div>

        {/* 残り日数/メッセージ */}
        <div className="vrc-note">
          {due ? (
            <span>自動移管の対象です。<button className="vrc-link" onClick={handleArchive} disabled={busy}>今すぐ履歴へ送る</button></span>
          ) : (
            <span>残り <b>{remainingDays}</b> 日で自動で履歴へ移ります。</span>
          )}
        </div>

        {/* アクション */}
        <div className="vrc-actions">
          <button className="vrc-btn ghost" onClick={handleResume} disabled={busy}>
            やっぱり再開
          </button>
          <button className="vrc-btn primary" onClick={handleArchive} disabled={busy}>
            履歴に送る
          </button>
        </div>
      </div>
    </article>
  );
}

function labelPhase(p: PhaseKey) {
  return p === 'initial' ? '初期' : p === 'mid' ? '中期' : '後期';
}
