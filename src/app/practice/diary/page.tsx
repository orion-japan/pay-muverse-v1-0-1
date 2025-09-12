// src/app/practice/diary/page.tsx
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useSwipeable } from 'react-swipeable';
import { dayjs, formatJST, shiftDays } from '@/lib/date';
import { fetchWithIdToken } from '@/lib/fetchWithIdToken';
import './Diary.css';

type LogItem = {
  id: string;
  habit_name?: string | null;
  vision_checked?: boolean | null;
  resonance_checked?: boolean | null;
  mood_text?: string | null;
  memo_text?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type MonthMap = Record<string, number>; // 'YYYY-MM-DD' -> count

export default function PracticeDiaryPage() {
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [monthMap, setMonthMap] = useState<MonthMap>({}); // ログがある日をマーキング
  const ym = dayjs(currentDate).tz().format('YYYY-MM');

  // 当月矩形（週頭〜週末）で7x5/6の配列化
  const monthDays = useMemo(() => {
    const start = dayjs(currentDate).tz().startOf('month').startOf('week');
    const end   = dayjs(currentDate).tz().endOf('month').endOf('week');
    const days: Date[] = [];
    for (let d = start; d.isBefore(end); d = d.add(1, 'day')) days.push(d.toDate());
    return days;
  }, [currentDate]);

  async function fetchMonthMap(monthStr: string) {
    const res = await fetchWithIdToken(`/api/practice/calendar?month=${monthStr}`);
    const json = await res.json();
    setMonthMap(json.days || {});
  }

  async function fetchLogs(date: Date) {
    setLoading(true);
    const q = dayjs(date).tz().format('YYYY-MM-DD');
    // ここを latest → diary に変更
    const res = await fetchWithIdToken(`/api/practice/logs?date=${q}&mode=diary`);
    const json = await res.json();
    setLogs(json.items || []);
    setLoading(false);
  }
  

  useEffect(() => { fetchMonthMap(ym); }, [ym]);
  useEffect(() => { fetchLogs(currentDate); }, [currentDate]);

  const handlers = useSwipeable({
    onSwipedLeft: () => setCurrentDate(prev => shiftDays(prev, 1)),
    onSwipedRight: () => setCurrentDate(prev => shiftDays(prev, -1)),
    trackMouse: true,
  });

  const selectedJst = dayjs(currentDate).tz().format('YYYY-MM-DD');

  const download = async (kind: 'day'|'month', format: 'md'|'csv') => {
    const key = kind === 'day'
      ? dayjs(currentDate).tz().format('YYYY-MM-DD')
      : dayjs(currentDate).tz().format('YYYY-MM');
    const url = `/api/practice/export?kind=${kind}&key=${key}&format=${format}`;
    // 認証付きで直接ダウンロードできるように、一時URLを叩いてblob保存
    const res = await fetchWithIdToken(url);
    const blob = await res.blob();
    const a = document.createElement('a');
    const href = URL.createObjectURL(blob);
    a.href = href;
    a.download = `practice_${kind}_${key}.${format}`;
    a.click();
    URL.revokeObjectURL(href);
  };

  return (
    <div className="diary-wrap" {...handlers}>
      {/* ヘッダー */}
      <div className="diary-header">
        <button onClick={() => setCurrentDate(shiftDays(currentDate, -1))}>{'‹'}</button>
        <strong>{dayjs(currentDate).tz().format('YYYY年 M月 D日 (ddd)')}</strong>
        <button onClick={() => setCurrentDate(shiftDays(currentDate, 1))}>{'›'}</button>
      </div>

      {/* ミニカレンダー（ログがある日は●マーク） */}
      <div className="mini-cal">
        {monthDays.map((d, i) => {
          const isThisMonth = dayjs(d).month() === dayjs(currentDate).month();
          const isToday = dayjs(d).isSame(dayjs(), 'day');
          const selected = dayjs(d).isSame(currentDate, 'day');
          const key = dayjs(d).tz().format('YYYY-MM-DD');
          const has = monthMap[key] > 0;
          return (
            <button
              key={i}
              className={`cal-cell ${isThisMonth ? '' : 'dim'} ${isToday ? 'today' : ''} ${selected ? 'selected' : ''}`}
              onClick={() => setCurrentDate(d)}
              aria-label={key}
              title={has ? `記録 ${monthMap[key]} 件` : ''}
            >
              {dayjs(d).date()}
              {has && <span className="dot" />}
            </button>
          );
        })}
      </div>

      {/* ダウンロードボタン */}
      <div className="download-row">
        <button onClick={() => download('day', 'md')}>この日をMD</button>
        <button onClick={() => download('day', 'csv')}>この日をCSV</button>
        <span className="spacer" />
        <button onClick={() => download('month', 'md')}>この月をMD</button>
        <button onClick={() => download('month', 'csv')}>この月をCSV</button>
      </div>

      {/* 日記カード */}
      <div className="diary-body">
        {loading && <div className="loading">読み込み中…</div>}
        {!loading && logs.length === 0 && (
          <div className="empty">
            {monthMap[selectedJst] ? 'この日のデータを読み込めませんでした' : 'この日は記録がありません'}
          </div>
        )}

        {!loading && logs.map((it) => (
          <article key={it.id} className="entry">
            <header className="entry-head">
              <h3>{it.habit_name || '実践チェック'}</h3>
              <small>{formatJST(it.created_at, 'YYYY/MM/DD HH:mm')}</small>
            </header>

            <ul className="flags">
              <li className={it.vision_checked ? 'on' : ''}>Vision</li>
              <li className={it.resonance_checked ? 'on' : ''}>共鳴</li>
            </ul>

            {it.mood_text && (
              <section>
                <h4>状況・気持ち</h4>
                <p>{it.mood_text}</p>
              </section>
            )}

            {it.memo_text && (
              <section>
                <h4>ひらめき・日記</h4>
                <p>{it.memo_text}</p>
              </section>
            )}
          </article>
        ))}
      </div>

      {/* ちょいCSS（点とダウンロード行） */}
      <style jsx>{`
        .mini-cal .cal-cell { position: relative; }
        .mini-cal .cal-cell .dot {
          position: absolute; left: 50%; bottom: 4px; width: 6px; height: 6px;
          border-radius: 50%; background: #6c8cff; transform: translateX(-50%);
        }
        .download-row {
          display: flex; gap: 8px; align-items: center; padding: 8px 6px 4px;
        }
        .download-row .spacer { flex: 1; }
        .download-row button {
          padding: 6px 10px; border-radius: 8px; border: 1px solid #ddd; background: #f9f9ff;
        }
      `}</style>
    </div>
  );
}
