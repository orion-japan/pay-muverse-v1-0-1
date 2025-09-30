// src/app/event/(sections)/calendar/page.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import '@/app/kyomeikai/kyomeikai.css';
import { useRouter } from 'next/navigation';

export const dynamic = 'force-dynamic'; // 完全動的
export const runtime = 'nodejs';        // Admin SDK を使う API があっても安全側に

/* ====== Utils（祝日判定のフォールバック付き）====== */
async function fetchIsJPHoliday(dateIso: string): Promise<boolean> {
  const d = new Date(dateIso);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  try {
    const res = await fetch(`/api/jp-holiday?date=${y}-${m}-${day}`);
    if (!res.ok) throw new Error('fallback');
    const j = await res.json();
    return !!j?.holiday;
  } catch {
    try {
      const res2 = await fetch(`/api/jp-holidays?date=${y}-${m}-${day}`);
      if (!res2.ok) throw new Error('fail');
      const j2 = await res2.json();
      return !!j2?.holiday;
    } catch {
      // 最後の手段：日曜なら祝日扱い
      return new Date(dateIso).getDay() === 0;
    }
  }
}

/* ===== 月カレンダー（表示・バッジ・祝日） ===== */
function MonthCalendar({ user_code, refreshKey }: { user_code: string; refreshKey: number }) {
  const [year, setYear] = useState<number>(() => new Date().getFullYear());
  const [month, setMonth] = useState<number>(() => new Date().getMonth() + 1); // 1-12
  const [days, setDays] = useState<Array<{ date: string; events: string[] }>>([]);
  const [holidays, setHolidays] = useState<Record<string, string>>({});

  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to = `${year}-${String(month).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;

  // 出席イベントの日付一覧
  useEffect(() => {
    if (!user_code) { setDays([]); return; }
    const q = new URLSearchParams({ from, to, user_code });
    fetch(`/api/attendance/days?${q}`)
      .then((r) => r.json())
      .then((j) => setDays(Array.isArray(j) ? j : []))
      .catch(() => setDays([]));
  }, [user_code, from, to, refreshKey]);

  // 月の祝日一覧
  useEffect(() => {
    fetch(`/api/jp-holidays?year=${year}&month=${month}`)
      .then((r) => r.json())
      .then((j) => {
        const map: Record<string, string> = {};
        for (const it of (j?.items ?? [])) map[it.date] = it.name;
        setHolidays(map);
      })
      .catch(() => setHolidays({}));
  }, [year, month]);

  const eventsByDate = new Map(days.map((d) => [d.date, d.events]));

  // グリッド生成（前月/翌月のはみ出しも含めて7の倍数に）
  const cells: Array<{ d: Date; out?: boolean }> = [];
  const startDow = first.getDay();
  for (let i = 0; i < startDow; i++) {
    const d = new Date(first);
    d.setDate(1 - (startDow - i));
    cells.push({ d, out: true });
  }
  for (let day = 1; day <= last.getDate(); day++) {
    cells.push({ d: new Date(year, month - 1, day) });
  }
  while (cells.length % 7 !== 0) {
    const d = new Date(last);
    d.setDate(d.getDate() + (cells.length % 7 ? 1 : 0));
    cells.push({ d, out: true });
  }


  const router = useRouter();

  return (
    <div className="km-wrap">

        {/* ← 戻るボタン */}
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => router.back()}
            className="km-button"
            type="button"
            aria-label="イベント一覧に戻る"
            style={{ padding: '6px 12px', fontSize: 14 }}
          >
            ← 戻る
          </button></div>

<div className="km-card km-cal">
      <div className="km-card-title">Event カレンダー</div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <button
          className="km-button"
          onClick={() => {
            const d = new Date(year, month - 2, 1);
            setYear(d.getFullYear()); setMonth(d.getMonth() + 1);
          }}
          type="button"
        >
          ← 前の月
        </button>

        <div className="km-cal-head">{year}年 {month}月</div>

        <button
          className="km-button"
          onClick={() => {
            const d = new Date(year, month, 1);
            setYear(d.getFullYear()); setMonth(d.getMonth() + 1);
          }}
          type="button"
        >
          次の月 →
        </button>

        <div style={{ marginLeft: 'auto', fontSize: 12 }}>
          <span className="km-badge kyomeikai">共鳴会</span>{' '}
          <span className="km-badge ainori">瞑想会</span>{' '}
          <span style={{ background:'#fff3f3', padding:'2px 6px', borderRadius:999, fontSize:10 }}>祝日</span>
        </div>
      </div>

      <div className="km-cal-grid km-cal-dow">
        <div>日</div><div>月</div><div>火</div><div>水</div><div>木</div><div>金</div><div>土</div>
      </div>

      <div className="km-cal-grid">
        {cells.map((c, i) => {
          const y = c.d.getFullYear();
          const m = String(c.d.getMonth() + 1).padStart(2, '0');
          const day = String(c.d.getDate()).padStart(2, '0');
          const iso = `${y}-${m}-${day}`;
          const ev = eventsByDate.get(iso) || [];
          const isHoliday = !!holidays[iso];

          const cls = ['km-cal-cell'];
          if (c.out) cls.push('km-cal-out');
          if (isHoliday) cls.push('km-cal-holiday');

          return (
            <div key={i} className={cls.join(' ')}>
              <div className="km-cal-date">{c.d.getDate()}</div>
              {ev.length > 0 && (
                <div className="km-cal-badges">
                  {ev.includes('kyomeikai') && <span className="km-badge kyomeikai">共鳴会</span>}
                  {ev.includes('ainori') && <span className="km-badge ainori">瞑想会</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div></div>
  );
}

/* ===== 参加履歴（表） ===== */
function HistoryTable({
  user, rangeFrom, rangeTo,
}: { user: string; rangeFrom: string; rangeTo: string }) {
  const [history, setHistory] = useState<Array<{ date: string; event_id: string; title?: string }>>([]);

  const load = async () => {
    try {
      if (!user) { setHistory([]); return; }
      const q = new URLSearchParams({ from: rangeFrom, to: rangeTo, user_code: user });
      const res = await fetch(`/api/attendance/history?${q.toString()}`);
      const j = await res.json().catch(() => ([] as any));
      setHistory(Array.isArray(j) ? j : []);
    } catch {
      setHistory([]);
    }
  };

  useEffect(() => { load(); /* 初回 */ }, [user]);

  const download = async () => {
    if (!user) return;
    const q = new URLSearchParams({ from: rangeFrom, to: rangeTo, user_code: user });
    const res = await fetch(`/api/attendance/export?${q.toString()}`, { method: 'GET' });
    if (!res.ok) { alert('ダウンロードに失敗しました'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `attendance_${user}_${rangeFrom}_${rangeTo}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };

  const router = useRouter();

  return (
    <div className="km-wrap">

        {/* ← 戻るボタン */}
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => router.back()}
            className="km-button"
            type="button"
            aria-label="イベント一覧に戻る"
            style={{ padding: '6px 12px', fontSize: 14 }}
          >
            ← 戻る
          </button></div>

      <div className="km-card-title">参加履歴</div>
      <div className="km-range" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button className="km-button" onClick={load} style={{ marginRight: 8 }} type="button">再読込</button>
        <button className="km-button" onClick={download} type="button">ダウンロード</button>
      </div>

      <div className="km-history" style={{ marginTop: 12 }}>
        {user ? (
          history.length ? (
            <table className="km-table">
              <thead>
                <tr><th>日付</th><th>イベント</th><th>タイトル</th></tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={i}>
                    <td>{h.date}</td>
                    <td>{h.event_id}</td>
                    <td>{h.title ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="km-muted">期間内の参加履歴はありません</div>
        ) : <div className="km-muted">参加履歴を表示するにはログインしてください</div>}
      </div>
    </div>
  );
}

/* ===== ページ本体 ===== */
export default function CalendarPage() {
  const params = useSearchParams();
  const { userCode: userCodeFromCtx } = useAuth();
  const userFromQuery = useMemo(() => params.get('user') || '', [params]);
  const user = (userFromQuery || userCodeFromCtx || '').trim();

  const [refreshKey] = useState(0);
  const [rangeFrom] = useState<string>(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10);
  });
  const [rangeTo] = useState<string>(() => new Date().toISOString().slice(0, 10));

  return (
    <div className="km-wrap">
      <MonthCalendar user_code={user} refreshKey={refreshKey} />
      <HistoryTable user={user} rangeFrom={rangeFrom} rangeTo={rangeTo} />
    </div>
  );
}
