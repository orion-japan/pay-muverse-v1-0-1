// src/components/DailyCheckPanel.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { formatJSTDate, formatJST_HM } from '@/lib/formatDate';
import { fetchWithIdToken } from '@/lib/fetchWithIdToken';
import { useRouter } from 'next/navigation';

type Props = {
  userCode: string;
  selectedVisionId: string;
  selectedStage: 'S' | 'F' | 'R' | 'C' | 'I';
  selectedVisionTitle?: string;
  className?: string;
  onArchived?: (visionId: string) => void;
};

type HistoryRow = {
  check_date: string;
  progress: number | null;
  vision_imaged?: boolean | null;
  resonance_shared?: boolean | null;
};

export default function DailyCheckPanel({
  userCode,
  selectedVisionId,
  selectedStage,
  selectedVisionTitle,
  className,
  onArchived,
}: Props) {
  /* ===== 状態 ===== */
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [visionImaged, setVisionImaged] = useState(false);
  const [resonanceShared, setResonanceShared] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [diaryText, setDiaryText] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [criteriaDays, setCriteriaDays] = useState<number | null>(null);
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const [criteriaSaving, setCriteriaSaving] = useState(false);
  const [criteriaLocal, setCriteriaLocal] = useState<number>(7);

  const today = useMemo(() => formatJSTDate(new Date()), []);

  /* ===== 進捗 ===== */
  const progress = useMemo(() => {
    let p = 0;
    if (visionImaged) p += 25;
    if (resonanceShared) p += 25;
    if (statusText.trim()) p += 25;
    if (diaryText.trim()) p += 25;
    return p;
  }, [visionImaged, resonanceShared, statusText, diaryText]);

  const router = useRouter();

  /* ===== 上書き防止フラグ ===== */
  const dirtyRef = useRef(false);
  const lastLocalAtRef = useRef<number>(0);
  function markDirty() {
    dirtyRef.current = true;
    lastLocalAtRef.current = Date.now();
  }

  /* ===== today フェッチ ===== */
  useEffect(() => {
    if (!userCode || !selectedVisionId) return;
    const ac = new AbortController();

    (async () => {
      setLoading(true);
      try {
        const url = `/api/daily-checks?user_code=${encodeURIComponent(
          userCode
        )}&vision_id=${encodeURIComponent(selectedVisionId)}&date=${today}`;
        const res = await fetch(url, { cache: 'no-store', signal: ac.signal });
        const json = await res.json().catch(() => ({} as any));
        if (!res.ok) throw new Error(json?.error || String(res.status));

        const d = json?.data;
        const serverAt = d?.updated_at ? Date.parse(d.updated_at) : 0;

        if (dirtyRef.current && lastLocalAtRef.current > serverAt) {
          const p = typeof d?.progress === 'number' ? d.progress : 0;
          if (p >= 100) setLocked(true);
        } else {
          setVisionImaged(!!d?.vision_imaged);
          setResonanceShared(!!d?.resonance_shared);
          setStatusText(d?.status_text ?? '');
          setDiaryText(d?.diary_text ?? '');
          setSavedAt(d && d.updated_at ? formatJST_HM(d.updated_at) : null);
          setLocked((d?.progress ?? 0) >= 100);
          dirtyRef.current = false;
          lastLocalAtRef.current = serverAt || Date.now();
        }
      } catch {
        /* noop */
      } finally {
        setLoading(false);
      }
    })();

    return () => ac.abort();
  }, [userCode, selectedVisionId, today]);

  /* ===== history フェッチ ===== */
  useEffect(() => {
    if (!userCode || !selectedVisionId) return;
    const ac = new AbortController();

    (async () => {
      try {
        const url = `/api/daily-checks?history=1&days=14&user_code=${encodeURIComponent(
          userCode
        )}&vision_id=${encodeURIComponent(selectedVisionId)}`;
        const res = await fetch(url, { cache: 'no-store', signal: ac.signal });
        if (!res.ok) {
          setHistory([]);
          return;
        }
        const json = await res.json().catch(() => ({} as any));
        setHistory(
          Array.isArray(json?.data) ? (json.data as HistoryRow[]) : []
        );
      } catch {
        setHistory([]);
      }
    })();

    return () => ac.abort();
  }, [userCode, selectedVisionId, savedAt]);

  /* ===== 自動保存（1.2秒） ===== */
  useEffect(() => {
    if (!userCode || !selectedVisionId || locked) return;
    if (!dirtyRef.current) return;
    const t = setTimeout(() => {
      void save();
    }, 1200);
    return () => clearTimeout(t);
  }, [visionImaged, resonanceShared, statusText, diaryText, userCode, selectedVisionId, locked]);

  /* ===== 保存 ===== */
  async function save() {
    if (saving || !userCode || !selectedVisionId) return;
    setSaving(true);
    try {
      const res = await fetch('/api/daily-checks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          user_code: userCode,
          vision_id: selectedVisionId,
          date: today,
          vision_imaged: visionImaged,
          resonance_shared: resonanceShared,
          status_text: statusText,
          diary_text: diaryText,
          progress,
          q_code: buildQCode({
            userCode,
            visionId: selectedVisionId,
            date: today,
            visionImaged,
            resonanceShared,
            progress,
          }),
          is_final: false, // 自動保存・手動保存ともに false 固定
        }),
      });
      const json = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(json?.error || 'save failed');

      const updatedAtISO: string | null = json?.data?.updated_at || null;
      setSavedAt(
        updatedAtISO
          ? formatJST_HM(updatedAtISO)
          : formatJST_HM(new Date())
      );

      dirtyRef.current = false;
      lastLocalAtRef.current = updatedAtISO
        ? Date.parse(updatedAtISO)
        : Date.now();

      if (progress >= 100) setLocked(true);

      showToast('✔ 保存しました');
    } catch (e) {
      console.error(e);
      showToast('保存に失敗しました');
    } finally {
      setSaving(false);
    }
  }

  /* ===== UI ===== */
  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 1200);
  }

  function unlockForEdit() {
    if (dayjs().format('YYYY-MM-DD') === today) setLocked(false);
  }

  function clearInputs() {
    setVisionImaged(false);
    setResonanceShared(false);
    setStatusText('');
    setDiaryText('');
    setLocked(false);
    markDirty();
  }

  /* ===== Qコード生成 ===== */
  function buildQCode(p: {
    userCode: string;
    visionId: string;
    date: string;
    visionImaged: boolean;
    resonanceShared: boolean;
    progress: number;
  }) {
    return {
      type: 'daily_check',
      user: p.userCode,
      vision_id: p.visionId,
      date: p.date,
      flags: {
        vision_imaged: p.visionImaged,
        resonance_shared: p.resonanceShared,
      },
      progress: p.progress,
      version: 1,
    };
  }

  /* ===== JSX ===== */
  return (
    <section className={`daily-check-panel ${className || ''}`}>
      <header className="dcp-head">
        <div>
          <strong>1日の実践チェック</strong>
          <span className="dcp-date">（{today}）</span>
          {selectedVisionTitle && (
            <div className="dcp-vision-title">
              <strong>{selectedVisionTitle}</strong>
              <span
                className={`dcp-status-badge ${
                  progress >= 100 ? 'done' : progress > 0 ? 'active' : 'new'
                }`}
              >
                {progress >= 100
                  ? '🎉 完了！'
                  : progress > 0
                  ? '実践中 💪'
                  : '未開始 ✨'}
              </span>
            </div>
          )}
        </div>

        <div className="dcp-status">
          {loading ? '読み込み中…' : savedAt ? `保存: ${savedAt}` : '新規'}
          {saving && ' / 保存中…'}
          <button
            className="dcp-criteria-btn"
            onClick={() => setCriteriaOpen((v) => !v)}
          >
            回数設定
          </button>
        </div>
      </header>

      {/* 進捗ゲージ */}
      <div className="dcp-progress">
        <div
          className={`dcp-progress-bar ${progress >= 100 ? 'is-done' : ''}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="dcp-progress-num">{progress}%</div>

      {!locked && (
        <>
          <div className="dcp-row">
            <label className="dcp-check">
              <input
                type="checkbox"
                checked={visionImaged}
                onChange={(e) => {
                  setVisionImaged(e.target.checked);
                  markDirty();
                }}
              />
              Vision：ビジョンについてイメージをした
            </label>
            <label className="dcp-check">
              <input
                type="checkbox"
                checked={resonanceShared}
                onChange={(e) => {
                  setResonanceShared(e.target.checked);
                  markDirty();
                }}
              />
              共鳴：誰かに伝えた／投稿した
            </label>
          </div>

          <div className="dcp-row">
            <label className="dcp-label">状況・気持ち</label>
            <textarea
              className="dcp-textarea"
              value={statusText}
              onChange={(e) => {
                setStatusText(e.target.value);
                markDirty();
              }}
            />
          </div>

          <div className="dcp-row">
            <label className="dcp-label">ひらめき・日記</label>
            <textarea
              className="dcp-textarea"
              value={diaryText}
              onChange={(e) => {
                setDiaryText(e.target.value);
                markDirty();
              }}
            />
          </div>

          <div className="dcp-actions">
            <button className="dcp-save" onClick={save} disabled={saving}>
              保存
            </button>
          </div>
        </>
      )}

      {toast && <div className="dcp-toast">{toast}</div>}
    </section>
  );
}
