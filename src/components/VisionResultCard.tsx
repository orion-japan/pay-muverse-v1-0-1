// src/components/VisionResultCard.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase'; // album://（Private）用の署名URL解決で使用

type PhaseKey = 'initial' | 'mid' | 'final';
type ResultStatus = '成功' | '中断' | '意図違い';
type VisionStatus =
  | '検討中'
  | '実践中'
  | '迷走中'
  | '順調'
  | 'ラストスパート'
  | '達成'
  | '破棄';

const AUTO_DAYS: Record<PhaseKey, number> = { initial: 7, mid: 14, final: 21 };
const ALBUM_BUCKET = 'private-posts'; // ★ ここで固定

export type VisionResultCardProps = {
  visionId: string;
  title: string;
  phase: PhaseKey;
  resultStatus: ResultStatus;
  resultedAt: string;                 // ISO
  userCode: string;                   // x-user-code ヘッダ用
  qCode?: string | null;              // バッジ表示用（※文字列以外は描画しない）
  thumbnailUrl?: string | null;       // サムネがあれば表示（直URL or album://path）
  /** ← ステータス（検討中/実践中...）をカードに表示 */
  visionStatus?: VisionStatus | null;
  onChanged?: () => void;             // 成功時のリフレッシュコールバック
  className?: string;
};

const STATUS_COLORS: Record<VisionStatus, string> = {
  検討中: '#94a3b8',
  実践中: '#22c55e',
  迷走中: '#f59e0b',
  順調: '#3b82f6',
  'ラストスパート': '#a855f7',
  達成: '#ef4444',
  破棄: '#6b7280',
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
  visionStatus,
  onChanged,
  className,
}: VisionResultCardProps) {
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false); // ★ 追加：成功時に自分を隠す
  const [resolvedThumb, setResolvedThumb] = useState<string | null>(null);

  // qCode が文字列以外の場合は描画しない（安全弁）
  const safeQCode = useMemo<string | null>(() => {
    return typeof qCode === 'string' ? qCode : null;
  }, [qCode]);

  // album://path → 署名URLに解決（Private album 対応）
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!thumbnailUrl) {
        if (alive) setResolvedThumb(null);
        return;
      }
      if (thumbnailUrl.startsWith('album://')) {
        try {
          // 'album://' を外し、余計な先頭スラッシュや 'private-posts/' を剥がす
          let path = thumbnailUrl.replace(/^album:\/\//, '').replace(/^\/+/, '');
          path = path.replace(new RegExp(`^(?:${ALBUM_BUCKET}/)+`), '');

          const { data, error } = await supabase
            .storage
            .from(ALBUM_BUCKET)                 // ★ ← album バケットを固定
            .createSignedUrl(path, 60 * 60);    // 1h

          if (!alive) return;
          if (error) {
            console.warn('[VRC] createSignedUrl error:', { error, bucket: ALBUM_BUCKET, path });
            setResolvedThumb(null);
          } else {
            setResolvedThumb(data?.signedUrl ?? null);
          }
        } catch (e) {
          if (alive) {
            console.warn('[VRC] thumb resolve error:', e);
            setResolvedThumb(null);
          }
        }
      } else {
        if (alive) setResolvedThumb(thumbnailUrl); // 直URL（http/https/data/blob等）はそのまま
      }
    })();
    return () => { alive = false; };
  }, [thumbnailUrl]);

  // 残り日数と進捗割合（自動移管まで） — resultedAt が不正でも NaN を出さない
  const { remainingDays, ratio, due } = useMemo(() => {
    const limit = AUTO_DAYS[phase] ?? 7;
    const baseMs = new Date(resultedAt).getTime();
    if (!Number.isFinite(baseMs)) {
      return { remainingDays: limit, ratio: 0, due: false };
    }
    const elapsedMs = Date.now() - baseMs;
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
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }

      // ★ 成功時の共通処理
      if (url.endsWith('/archive')) {
        // 1) 自分自身を即時非表示（楽観的）
        setHidden(true);
        // 2) 他の画面へも通知（VisionPage などが購読していれば即消える）
        try { localStorage.setItem(`vision.hidden.${visionId}`, '1'); } catch {}
        window.dispatchEvent(new CustomEvent('vision:archived', { detail: { visionId } }));
      }

      onChanged?.();
    } catch (e: any) {
      console.error('[VisionResultCard] request failed:', e);
      alert(`処理に失敗しました: ${e?.message || e}`);
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

  // ★ 非表示フラグが立っていたら描画しない
  if (hidden) return null;

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
      {/* サムネ（必要なら表示） */}
      {resolvedThumb && (
        <div className="vrc-thumb">
          <img src={resolvedThumb} alt="" />
        </div>
      )}

      {/* 本体 */}
      <div className="vrc-body">
        <div className="vrc-top">
          {/* ★ ステータスを最優先で表示。未指定なら従来の結果バッジを表示 */}
          <span className="vrc-badge" data-vs={visionStatus || undefined}>
            {visionStatus ?? resultStatus}
          </span>

          {safeQCode && <span className="vrc-q">Q:{safeQCode}</span>}
          <span className="vrc-phase">{labelPhase(phase)}</span>
        </div>

        <h3 id={`vrc-title-${visionId}`} className="vrc-title">
          {title || '(無題)'}
        </h3>

        {/* 自動移管までのガイドバー */}
        <div
          className="vrc-rail"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)}
        >
          <div className="vrc-rail__bar" style={{ width: `${(Number.isFinite(ratio) ? ratio : 0) * 100}%` }} />
        </div>

        {/* 残り日数/メッセージ */}
        <div className="vrc-note">
          {due ? (
            <span>
              自動移管の対象です。
              <button className="vrc-link" onClick={handleArchive} disabled={busy}>
                今すぐ履歴へ送る
              </button>
            </span>
          ) : (
            <span>
              残り <b>{remainingDays}</b> 日で自動で履歴へ移ります。
            </span>
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
