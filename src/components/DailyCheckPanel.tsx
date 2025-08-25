'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';

type Props = {
  userCode: string;
  selectedVisionId: string;
  selectedStage: 'S'|'F'|'R'|'C'|'I';
  selectedVisionTitle?: string;
  className?: string;
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
  className
}: Props) {
  /* ===== 状態 ===== */
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
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

  /* ===== 定数 ===== */
  const today = useMemo(() => dayjs().format('YYYY-MM-DD'), []);

  /* ===== 進捗 ===== */
  const progress = useMemo(() => {
    let p = 0;
    if (visionImaged) p += 25;
    if (resonanceShared) p += 25;
    if (statusText.trim()) p += 25;
    if (diaryText.trim()) p += 25;
    return p;
  }, [visionImaged, resonanceShared, statusText, diaryText]);

  /* ===== 上書き防止フラグ =====
     - ユーザーが編集した瞬間に dirty を立て、最終編集時刻を保持
     - サーバーの updated_at がこれより古ければ「適用しない」 */
  const dirtyRef = useRef(false);
  const lastLocalAtRef = useRef<number>(0);

  function markDirty() {
    dirtyRef.current = true;
    lastLocalAtRef.current = Date.now();
  }

  /* ===== today フェッチ（レース防止 + デバウンス） ===== */
  const todaySeqRef = useRef(0);
  const todayDebounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!userCode || !selectedVisionId) return;
    if (todayDebounceRef.current) clearTimeout(todayDebounceRef.current);

    todayDebounceRef.current = window.setTimeout(() => {
      const seq = ++todaySeqRef.current;
      const ac = new AbortController();

      (async () => {
        setLoading(true);
        try {
          const url = `/api/daily-checks?user_code=${encodeURIComponent(userCode)}&vision_id=${encodeURIComponent(selectedVisionId)}&date=${today}`;
          const res = await fetch(url, { cache: 'no-store', signal: ac.signal });
          const json = await res.json().catch(() => ({} as any));
          if (!res.ok) throw new Error(json?.error || String(res.status));

          // 最新でなければ破棄
          if (seq !== todaySeqRef.current) return;

          const d = json?.data;
          const serverAt = d?.updated_at ? Date.parse(d.updated_at) : 0;

          // ★★ ここが核心：ローカルの方が新しければサーバー値で上書きしない
          if (dirtyRef.current && lastLocalAtRef.current > serverAt) {
            // ただし、サーバー側が100%になっていたらロックだけは反映
            const p = typeof d?.progress === 'number' ? d.progress : 0;
            if (p >= 100) setLocked(true);
          } else {
            setVisionImaged(!!d?.vision_imaged);
            setResonanceShared(!!d?.resonance_shared);
            setStatusText(d?.status_text ?? '');
            setDiaryText(d?.diary_text ?? '');
            setSavedAt(d && d.updated_at ? dayjs(d.updated_at).format('HH:mm') : null);
            setLocked((d?.progress ?? 0) >= 100);
            dirtyRef.current = false;                 // サーバーと同期できたので dirty を下ろす
            lastLocalAtRef.current = serverAt || Date.now();
          }
        } catch {
          /* noop */
        } finally {
          setLoading(false);
        }
      })();

      return () => ac.abort();
    }, 140);

    return () => {
      if (todayDebounceRef.current) clearTimeout(todayDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userCode, selectedVisionId]);

  /* ===== history フェッチ（保存完了時にも更新） ===== */
  const histSeqRef = useRef(0);
  const histDebounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!userCode || !selectedVisionId) return;
    if (histDebounceRef.current) clearTimeout(histDebounceRef.current);

    histDebounceRef.current = window.setTimeout(() => {
      const seq = ++histSeqRef.current;
      const ac = new AbortController();

      (async () => {
        try {
          const url = `/api/daily-checks?history=1&days=14&user_code=${encodeURIComponent(userCode)}&vision_id=${encodeURIComponent(selectedVisionId)}`;
          const res = await fetch(url, { cache: 'no-store', signal: ac.signal });
          if (!res.ok) { if (seq === histSeqRef.current) setHistory([]); return; }
          const json = await res.json().catch(() => ({} as any));
          if (seq !== histSeqRef.current) return;
          setHistory(Array.isArray(json?.data) ? (json.data as HistoryRow[]) : []);
        } catch {
          setHistory([]);
        }
      })();

      return () => ac.abort();
    }, 140);

    return () => {
      if (histDebounceRef.current) clearTimeout(histDebounceRef.current);
    };
  }, [userCode, selectedVisionId, savedAt]);

  /* ===== ステージの required_days ===== */
  useEffect(() => {
    let abort = false;
    (async () => {
      try {
        const { getAuth, signInAnonymously } = await import('firebase/auth');
        const auth = getAuth();
        if (!auth.currentUser) await signInAnonymously(auth);
        const token = await auth.currentUser!.getIdToken();

        const res = await fetch(
          `/api/vision-criteria?vision_id=${encodeURIComponent(selectedVisionId)}&from=${selectedStage}`,
          { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }
        );
        if (!res.ok) { if (!abort) setCriteriaDays(null); return; }
        const data = await res.json().catch(() => ({} as any));
        if (!abort) setCriteriaDays(data?.required_days ?? null);
      } catch {
        if (!abort) setCriteriaDays(null);
      }
    })();
    return () => { abort = true; };
  }, [selectedVisionId, selectedStage]);

  /* ===== 自動保存（1.2秒）※ロック中は発火しない ===== */
  useEffect(() => {
    if (!userCode || !selectedVisionId || locked) return;
    const t = setTimeout(() => { void save(); }, 1200);
    return () => clearTimeout(t);
  }, [visionImaged, resonanceShared, statusText, diaryText, userCode, selectedVisionId, locked]);

  /* ===== UI ユーティリティ ===== */
  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 1200);
  }

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
            userCode, visionId: selectedVisionId, date: today,
            visionImaged, resonanceShared, progress
          }),
        }),
      });
      const json = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(json?.error || 'save failed');

      const updatedAtISO: string | null = json?.data?.updated_at || null;
      setSavedAt(updatedAtISO ? dayjs(updatedAtISO).format('HH:mm') : dayjs().format('HH:mm'));

      // 保存成功 → サーバーの方が新しいので dirty を下ろす
      dirtyRef.current = false;
      lastLocalAtRef.current = updatedAtISO ? Date.parse(updatedAtISO) : Date.now();

      // ロックは「本当に 100% のときだけ」
      if (progress >= 100) setLocked(true);

      showToast('✔ 保存しました');
    } catch (e) {
      console.error(e);
      showToast('保存に失敗しました');
    } finally {
      setSaving(false);
    }
  }

  function unlockForEdit() {
    // 当日だけ再編集可にする想定
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

  /* ===== 連続日数 ===== */
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

  /* ===== required_days 保存 ===== */
  async function saveRequiredDays(newDays: number) {
    try {
      setCriteriaSaving(true);
      const { getAuth, signInAnonymously } = await import('firebase/auth');
      const auth = getAuth();
      if (!auth.currentUser) await signInAnonymously(auth);
      const token = await auth.currentUser!.getIdToken();

      const res = await fetch('/api/vision-criteria', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        cache: 'no-store',
        body: JSON.stringify({
          vision_id: selectedVisionId,
          from: selectedStage,
          required_days: newDays,
          checklist: [],
        }),
      });
      const json = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(json?.error || 'failed');
      setCriteriaDays(json?.required_days ?? newDays);
      setCriteriaOpen(false);
      showToast('✔ 回数を更新しました');
    } catch (e) {
      console.error(e);
      showToast('回数の更新に失敗しました');
    } finally {
      setCriteriaSaving(false);
    }
  }

  /* ===== ここから JSX（構造は元のまま） ===== */
  return (
    <section className={`daily-check-panel ${className || ''}`}>
      <header className="dcp-head">
        <div>
          <strong>1日の実践チェック</strong>
          <span className="dcp-date">（{today}）</span>
          {selectedVisionTitle && <span className="dcp-vision-title"> / {selectedVisionTitle}</span>}
        </div>
        <div className="dcp-status">
          {loading ? '読み込み中…' : savedAt ? `保存: ${savedAt}` : '新規'}
          {saving && ' / 保存中…'}
          <button
            className="dcp-criteria-btn"
            onClick={() => setCriteriaOpen(v => !v)}
            title="このステージで何回やるか設定"
          >
            回数設定
          </button>
        </div>
      </header>

      {criteriaOpen && (
        <div className="dcp-criteria-box">
          <div className="dcp-criteria-row">
            <span>このステージの目安回数：</span>
            <input
              type="number"
              min={0}
              step={1}
              defaultValue={criteriaDays ?? 3}
              id="dcp-criteria-input"
              className="dcp-criteria-input"
            />
            <button
              className="dcp-criteria-save"
              disabled={criteriaSaving}
              onClick={() => {
                const el = document.getElementById('dcp-criteria-input') as HTMLInputElement | null;
                const v = el ? Math.max(0, Math.floor(Number(el.value || 0))) : 0;
                void saveRequiredDays(v);
              }}
            >
              {criteriaSaving ? '保存中…' : '保存'}
            </button>
            {criteriaDays != null && <span className="dcp-criteria-current">現在: {criteriaDays} 回</span>}
          </div>
        </div>
      )}

      <div className="dcp-progress">
        <div className="dcp-progress-bar" style={{ width: `${progress}%` }} />
      </div>
      <div className="dcp-progress-num">{progress}%（連続 {streak} 日）</div>

      {!locked && (
        <>
          <div className="dcp-row">
            <label className="dcp-check">
              <input
                type="checkbox"
                checked={visionImaged}
                onChange={(e) => { setVisionImaged(e.target.checked); markDirty(); }}
              />
              Vision：ビジョンについてイメージをした
            </label>
            <label className="dcp-check">
              <input
                type="checkbox"
                checked={resonanceShared}
                onChange={(e) => { setResonanceShared(e.target.checked); markDirty(); }}
              />
              共鳴：誰かに伝えた／投稿した
            </label>
          </div>

          <div className="dcp-row">
            <label className="dcp-label">状況・気持ち</label>
            <textarea
              className="dcp-textarea"
              placeholder="今日の状況や気持ちを記録…"
              value={statusText}
              onChange={(e) => { setStatusText(e.target.value); markDirty(); }}
              rows={3}
            />
          </div>

          <div className="dcp-row">
            <label className="dcp-label">ひらめき・日記</label>
            <textarea
              className="dcp-textarea"
              placeholder="浮かんだアイデアや出来事…"
              value={diaryText}
              onChange={(e) => { setDiaryText(e.target.value); markDirty(); }}
              rows={4}
            />
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

/* ===== 補助 ===== */

async function copyFromYesterday(this: void) {
  // 必要に応じて実装
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
