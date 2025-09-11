// src/app/practice/diary/page.tsx
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useSwipeable } from 'react-swipeable';
import { dayjs, formatJST, shiftDays } from '@/lib/date';
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

export default function PracticeDiaryPage() {
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [loading, setLoading] = useState(false);

  // カレンダー用：当月の全日
  const monthDays = useMemo(() => {
    const start = dayjs(currentDate).tz().startOf('month').startOf('week'); // 週頭から
    const end   = dayjs(currentDate).tz().endOf('month').endOf('week');
    const days: Date[] = [];
    for (let d = start; d.isBefore(end); d = d.add(1, 'day')) {
      days.push(d.toDate());
    }
    return days;
  }, [currentDate]);

  async function fetchLogs(date: Date) {
    setLoading(true);
    const q = dayjs(date).tz().format('YYYY-MM-DD');
    const res = await fetch(`/api/practice/logs?date=${q}`);
    const json = await res.json();
    setLogs(json.items || []);
    setLoading(false);
  }

  useEffect(() => { fetchLogs(currentDate); }, [currentDate]);

  const handlers = useSwipeable({
    onSwipedLeft: () => setCurrentDate(prev => shiftDays(prev, 1)),
    onSwipedRight: () => setCurrentDate(prev => shiftDays(prev, -1)),
    trackMouse: true,
  });

  return (
    <div className="diary-wrap" {...handlers}>
      {/* ヘッダー */}
      <div className="diary-header">
        <button onClick={() => setCurrentDate(shiftDays(currentDate, -1))}>{'‹'}</button>
        <strong>{dayjs(currentDate).tz().format('YYYY年 M月 D日 (ddd)')}</strong>
        <button onClick={() => setCurrentDate(shiftDays(currentDate, 1))}>{'›'}</button>
      </div>

      {/* ミニカレンダー */}
      <div className="mini-cal">
        {monthDays.map((d, i) => {
          const isThisMonth = dayjs(d).month() === dayjs(currentDate).month();
          const isToday = dayjs(d).isSame(dayjs(), 'day');
          const selected = dayjs(d).isSame(currentDate, 'day');
          return (
            <button
              key={i}
              className={`cal-cell ${isThisMonth ? '' : 'dim'} ${isToday ? 'today' : ''} ${selected ? 'selected' : ''}`}
              onClick={() => setCurrentDate(d)}
              aria-label={dayjs(d).tz().format('YYYY-MM-DD')}
            >
              {dayjs(d).date()}
            </button>
          );
        })}
      </div>

      {/* 日記カード */}
      <div className="diary-body">
        {loading && <div className="loading">読み込み中…</div>}

        {!loading && logs.length === 0 && (
          <div className="empty">この日は記録がありません</div>
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
    </div>
  );
}
