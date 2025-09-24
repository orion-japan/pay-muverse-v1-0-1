// src/app/practice/diary/page.tsx
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useSwipeable } from 'react-swipeable';
import { dayjs, shiftDays } from '@/lib/date';
import { formatJSTDate, formatJST_HM } from '@/lib/formatDate';
import { fetchWithIdToken } from '@/lib/fetchWithIdToken';
import './Diary.css';

type LogItem = {
  id: string;
  check_date?: string | null;           // JSTの暦日（YYYY-MM-DD）
  habit_name?: string | null;
  vision_checked?: boolean | null;
  resonance_checked?: boolean | null;
  mood_text?: string | null;
  memo_text?: string | null;
  created_at?: string | null;           // 'YYYY-MM-DD HH:MM:SS(.ms)?' or ISO
  updated_at?: string | null;           // 同上
};

type MonthMap = Record<string, number>; // 'YYYY-MM-DD' -> count

/** Date -> JST 'YYYY-MM-DD' */
function toJstYmd(d: Date | null): string | null {
  if (!d) return null;
  const s = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const [y, m, dd] = s.split('/');
  return `${y}-${m}-${dd}`;
}

/** "YYYY-MM-DD HH:MM(:SS[.ms])?" を UTC として解釈 */
function parseAsUtc(input?: string | null): Date | null {
  if (!input) return null;
  const hasTZ = /[zZ]|[+-]\d{2}:\d{2}$/.test(input);
  if (hasTZ) {
    const d = new Date(input);
    return isNaN(d.getTime()) ? null : d;
  }
  const iso = input.includes('T') ? `${input}Z` : input.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** "YYYY-MM-DD HH:MM(:SS[.ms])?" を ローカル として解釈 */
function parseAsLocal(input?: string | null): Date | null {
  if (!input) return null;
  const s = input.includes('T') ? input : input.replace(' ', 'T');
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// 置き換え：created_at を優先し、check_date(JST) と整合する方を選ぶ
function chooseTimestampForDisplay(
  updated_at?: string | null,
  created_at?: string | null,
  check_date?: string | null
): Date | null {
  // まず両方を UTC/Local でパース
  const cUTC = parseAsUtc(created_at || undefined);
  const cLOC = parseAsLocal(created_at || undefined);
  const uUTC = parseAsUtc(updated_at || undefined);
  const uLOC = parseAsLocal(updated_at || undefined);

  const cd = check_date || null;
  const cUTCymd = toJstYmd(cUTC);
  const cLOCymd = toJstYmd(cLOC);
  const uUTCymd = toJstYmd(uUTC);
  const uLOCymd = toJstYmd(uLOC);

  // 1) check_date があれば、まず created_at 側で一致するものを最優先
  if (cd) {
    if (cUTC && cUTCymd === cd) return cUTC;
    if (cLOC && cLOCymd === cd) return cLOC;
    // 2) ついでに updated_at 側で一致するもの
    if (uUTC && uUTCymd === cd) return uUTC;
    if (uLOC && uLOCymd === cd) return uLOC;
  }

  // 3) フォールバック：created_at を優先、なければ updated_at
  return cUTC ?? cLOC ?? uUTC ?? uLOC ?? null;
}


export default function PracticeDiaryPage() {
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [monthMap, setMonthMap] = useState<MonthMap>({});
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

      {/* ミニカレンダー */}
      <div className="mini-cal">
        {monthDays.map((d, i) => {
          const isThisMonth = dayjs(d).month() === dayjs(currentDate).month();
          const isToday = dayjs(d).isSame(dayjs(), 'day');
          const selected = dayjs(d).isSame(currentDate, 'day');
          const key = dayjs(d).tz().format('YYYY-MM-DD'); // サーバの monthMap は JST日付キー
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

      {/* ダウンロード */}
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

        {!loading && logs.map((it) => {
          // 表示日の基準は check_date（JST 暦日）。時刻はタイムスタンプから整合する方を採用。
          const chosen = chooseTimestampForDisplay(it.updated_at, it.created_at, it.check_date || undefined);
          const headDate = it.check_date
            ? formatJSTDate(it.check_date)
            : formatJSTDate(chosen ?? (it.updated_at ?? it.created_at));
          const headTime = chosen ? formatJST_HM(chosen) : '';

          return (
            <article key={it.id} className="entry">
              <header className="entry-head">
                <h3>{it.habit_name || '実践チェック'}</h3>
                <small>{`${headDate}${headTime ? ` ${headTime}` : ''}`}</small>
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
          );
        })}
      </div>

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
