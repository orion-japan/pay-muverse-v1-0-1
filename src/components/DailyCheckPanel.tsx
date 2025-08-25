'use client';

import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';

type Props = {
  userCode: string;
  selectedVisionId: string;
  className?: string;
};

type HistoryRow = {
  check_date: string;
  progress: number | null;
  vision_imaged?: boolean | null;
  resonance_shared?: boolean | null;
};

export default function DailyCheckPanel({ userCode, selectedVisionId, className }: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [visionImaged, setVisionImaged] = useState(false);
  const [resonanceShared, setResonanceShared] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [diaryText, setDiaryText] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const LOCK_ON_SAVE_ALWAYS = true;
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const today = useMemo(() => dayjs().format('YYYY-MM-DD'), []);

  const progress = useMemo(() => {
    let p = 0;
    if (visionImaged) p += 25;
    if (resonanceShared) p += 25;
    if (statusText.trim()) p += 25;
    if (diaryText.trim()) p += 25;
    return p;
  }, [visionImaged, resonanceShared, statusText, diaryText]);

  // 当日分フェッチ
  useEffect(() => {
    if (!userCode || !selectedVisionId) return;
    const run = async () => {
      setLoading(true);
      try {
        const url = `/api/daily-checks?user_code=${encodeURIComponent(userCode)}&vision_id=${encodeURIComponent(selectedVisionId)}&date=${today}`;
        const res = await fetch(url);
        const json = await res.json();
        const d = json?.data;
        setVisionImaged(!!d?.vision_imaged);
        setResonanceShared(!!d?.resonance_shared);
        setStatusText(d?.status_text ?? '');
        setDiaryText(d?.diary_text ?? '');
        setSavedAt(d ? dayjs(d.updated_at).format('HH:mm') : null);
        setLocked((d?.progress ?? 0) >= 100);
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [userCode, selectedVisionId, today]);

  // 履歴フェッチ
  useEffect(() => {
    if (!userCode || !selectedVisionId) return;
    const run = async () => {
      const url = `/api/daily-checks?history=1&days=14&user_code=${encodeURIComponent(userCode)}&vision_id=${encodeURIComponent(selectedVisionId)}`;
      try {
        const res = await fetch(url);
        if (!res.ok) { setHistory([]); return; }
        const json = await res.json();
        setHistory(Array.isArray(json?.data) ? (json.data as HistoryRow[]) : []);
      } catch {
        setHistory([]);
      }
    };
    run();
  }, [userCode, selectedVisionId, savedAt]);

  // 自動保存（1.2秒）※ロック中は発火しない
  useEffect(() => {
    if (!userCode || !selectedVisionId || locked) return;
    const t = setTimeout(() => { void save(); }, 1200);
    return () => clearTimeout(t);
  }, [visionImaged, resonanceShared, statusText, diaryText, userCode, selectedVisionId, locked]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 1200);
  }

  async function save() {
    if (saving || !userCode || !selectedVisionId) return;
    setSaving(true);
    try {
      const res = await fetch('/api/daily-checks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_code: userCode,
          vision_id: selectedVisionId,
          date: today,
          vision_imaged: visionImaged,
          resonance_shared: resonanceShared,
          status_text: statusText,
          diary_text: diaryText,
          progress,
          q_code: buildQCode({ userCode, visionId: selectedVisionId, date: today, visionImaged, resonanceShared, progress }),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'save failed');
      setSavedAt(dayjs(json.data.updated_at).format('HH:mm'));
      showToast('✔ 保存しました');
      if (progress >= 0 || LOCK_ON_SAVE_ALWAYS) setLocked(true);
    } catch (e) {
      console.error(e);
      showToast('保存に失敗しました');
    } finally {
      setSaving(false);
    }
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
  }

  const streak = useMemo(() => {
    let s = 0;
    const map = new Map(history.map(h => [h.check_date, (h.progress ?? 0) > 0]));
    for (let i = 0; i < 60; i++) {
      const d = dayjs(today).subtract(i, 'day').format('YYYY-MM-DD');
      const done = i === 0 ? progress > 0 : !!map.get(d);
      if (done) s++; else break;
    }
    return s;
  }, [history, progress, today]);

  return (
    <section className={`daily-check-panel ${className || ''}`}>
      <header className="dcp-head">
        <div>
          <strong>1日の実践チェック</strong>
          <span className="dcp-date">（{today}）</span>
        </div>
        <div className="dcp-status">
          {loading ? '読み込み中…' : savedAt ? `保存: ${savedAt}` : '新規'}
          {saving && ' / 保存中…'}
        </div>
      </header>

      <div className="dcp-progress">
        <div className="dcp-progress-bar" style={{ width: `${progress}%` }} />
      </div>
      <div className="dcp-progress-num">{progress}%（連続 {streak} 日）</div>

      {!locked && (
        <>
          <div className="dcp-row">
            <label className="dcp-check">
              <input type="checkbox" checked={visionImaged} onChange={(e) => setVisionImaged(e.target.checked)} />
              Vision：ビジョンについてイメージをした
            </label>
            <label className="dcp-check">
              <input type="checkbox" checked={resonanceShared} onChange={(e) => setResonanceShared(e.target.checked)} />
              共鳴：誰かに伝えた／投稿した
            </label>
          </div>

          <div className="dcp-row">
            <label className="dcp-label">状況・気持ち</label>
            <textarea className="dcp-textarea" placeholder="今日の状況や気持ちを記録…" value={statusText} onChange={(e) => setStatusText(e.target.value)} rows={3} />
          </div>

          <div className="dcp-row">
            <label className="dcp-label">ひらめき・日記</label>
            <textarea className="dcp-textarea" placeholder="浮かんだアイデアや出来事…" value={diaryText} onChange={(e) => setDiaryText(e.target.value)} rows={4} />
          </div>

          <div className="dcp-actions">
            <button className="dcp-copy" onClick={copyFromYesterday}>昨日コピー</button>
            <button className="dcp-save" onClick={save}>保存</button>
          </div>
        </>
      )}

      {locked && (
        <div className="dcp-done">
          <div className="dcp-done-badge">本日分は完了しました 🎉</div>

          <div className="dcp-done-block">
            <div className="dcp-done-title">チェック結果</div>
            <ul className="dcp-done-list">
              <li>Vision イメージ：{visionImaged ? '✔' : '—'}</li>
              <li>共鳴（伝達／投稿）：{resonanceShared ? '✔' : '—'}</li>
            </ul>
            {statusText && (<><div className="dcp-done-title">状況・気持ち</div><div className="dcp-done-text">{statusText}</div></>)}
            {diaryText && (<><div className="dcp-done-title">ひらめき・日記</div><div className="dcp-done-text">{diaryText}</div></>)}
          </div>

          <div className="dcp-actions">
            <button className="dcp-copy" onClick={clearInputs}>入力をクリア</button>
            {dayjs().format('YYYY-MM-DD') === today && (
              <button className="dcp-save" onClick={unlockForEdit}>再編集</button>
            )}
          </div>
        </div>
      )}

      <div className="dcp-history">
        {buildDays(14).map(d => {
          const row = history.find(h => h.check_date === d);
          const val = d === today ? progress : (row?.progress ?? 0);
          return (
            <div key={d} className="dcp-hitem" title={`${d} : ${val}%`}>
              <div className="dcp-hbar" style={{ height: `${Math.max(4, Math.round((val/100)*24))}px` }} />
              <div className="dcp-hday">{dayjs(d).format('D')}</div>
            </div>
          )
        })}
      </div>

      {toast && <div className="dcp-toast">{toast}</div>}
    </section>
  );
}

async function copyFromYesterday(this: void) {
  // この関数はコンポーネント内で参照されるので、上に移してもOK
}

function buildDays(n: number) {
  const arr: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    arr.push(dayjs().subtract(i, 'day').format('YYYY-MM-DD'));
  }
  return arr;
}

function buildQCode(p: {
  userCode: string; visionId: string; date: string;
  visionImaged: boolean; resonanceShared: boolean; progress: number;
}) {
  return {
    type: 'daily_check',
    user: p.userCode,
    vision_id: p.visionId,
    date: p.date,
    flags: { vision_imaged: p.visionImaged, resonance_shared: p.resonanceShared },
    progress: p.progress,
    version: 1,
  };
}
