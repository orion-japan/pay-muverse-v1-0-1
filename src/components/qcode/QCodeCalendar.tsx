'use client';

import { useEffect, useMemo, useState } from 'react';

type QLog = {
  for_date: string; // 'YYYY-MM-DD'
  q_code?: {
    currentQ?: 'Q1'|'Q2'|'Q3'|'Q4'|'Q5';
    polarity?: 'ease'|'now'|'yin'|'yang';
  };
  intent?: string | null;
};

export default function QCodeCalendar({
  days,
  intent,
  onSelectDay,
}: {
  days: '30' | '60' | '90';
  intent: 'all'|'self_post'|'event_attend'|'vision_check';
  onSelectDay?: (date: string, logs: QLog[]) => void;
}) {
  const [items, setItems] = useState<QLog[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const q = new URLSearchParams({ days, limit: '500' });
        if (intent !== 'all') q.set('intent', intent);
        const res = await fetch(`/api/qcode/log?${q}`);
        const json = await res.json();
        setItems(json.items ?? []);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [days, intent]);

  // 期間の開始・終了（日付配列を作る）
  const { daysList, dayMap } = useMemo(() => {
    const today = new Date();
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const start = new Date(end);
    start.setUTCDate(end.getUTCDate() - (parseInt(days) - 1));

    // カレンダーは週頭（日）に合わせて展開（前方パディング）
    const padStart = start.getUTCDay(); // 0..6
    const firstCell = new Date(start);
    firstCell.setUTCDate(start.getUTCDate() - padStart);

    // 後方も週末（土）までパディング
    const padEnd = 6 - end.getUTCDay();
    const lastCell = new Date(end);
    lastCell.setUTCDate(end.getUTCDate() + padEnd);

    const list: string[] = [];
    const map: Record<string, QLog[]> = {};
    for (let d = new Date(firstCell); d <= lastCell; d.setUTCDate(d.getUTCDate() + 1)) {
      const s = toYMD(d);
      list.push(s);
      map[s] = [];
    }

    for (const it of items) {
      if (!it.for_date) continue;
      if (!map[it.for_date]) map[it.for_date] = [];
      map[it.for_date].push(it);
    }

    return { daysList: list, dayMap: map };
  }, [items, days]);

  // 色ロジック：Qごとの基本色
  const BASE: Record<'Q1'|'Q2'|'Q3'|'Q4'|'Q5', string> = {
    Q1:'#7b8da4', Q2:'#5aa06a', Q3:'#c2a05a', Q4:'#5a88c2', Q5:'#c25a5a'
  };
  const easeColor = (hex: string, alpha = 0.45) => {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${alpha})`;
  };

  // 1日の色：最頻Qを採用し、Ease/Now の優勢で濃淡を切替
  const colorForDay = (dayLogs: QLog[]) => {
    if (!dayLogs?.length) return '#e8edf5';
    const qCount: Record<string, number> = {};
    const polCount: Record<string, { ease:number; now:number }> = {};

    for (const l of dayLogs) {
      const q = l?.q_code?.currentQ;
      if (!q) continue;
      qCount[q] = (qCount[q] ?? 0) + 1;
      if (!polCount[q]) polCount[q] = { ease:0, now:0 };
      const pol = l?.q_code?.polarity as ('ease'|'now'|undefined);
      if (pol === 'ease') polCount[q].ease++;
      else polCount[q].now++;
    }

    const topQ = (Object.entries(qCount).sort((a,b)=>b[1]-a[1])[0]?.[0] ?? 'Q3') as 'Q1'|'Q2'|'Q3'|'Q4'|'Q5';
    const { ease, now } = polCount[topQ] ?? { ease:0, now:0 };
    if (ease === now) return easeColor(BASE[topQ], 0.65);
    if (ease > now)   return easeColor(BASE[topQ], 0.45);
    return BASE[topQ];
  };

  // クリック
  const handleClick = (d: string) => {
    onSelectDay?.(d, dayMap[d] ?? []);
  };

  return (
    <div>
      {/* ヘッダー */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:8, fontSize:12, color:'#6a7a8a', marginBottom:6 }}>
        {['日','月','火','水','木','金','土'].map((w)=>(
          <div key={w} style={{ textAlign:'center' }}>{w}</div>
        ))}
      </div>

      {/* カレンダー本体 */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:8 }}>
        {daysList.map((d) => {
          const logs = dayMap[d] ?? [];
          const bg = colorForDay(logs);
          const dayNum = parseInt(d.slice(-2), 10);
          const has = logs.length > 0;
          return (
            <button
              key={d}
              onClick={()=>handleClick(d)}
              title={d}
              style={{
                aspectRatio:'1 / 1',
                borderRadius:8,
                border:'1px solid #e3e8f2',
                background:bg,
                display:'grid',
                placeItems:'center',
                cursor:'pointer',
                outline:'none'
              }}
            >
              <span style={{ fontWeight:600, color: has ? '#223' : '#889' }}>{dayNum}</span>
            </button>
          );
        })}
      </div>

      {loading && <p style={{ marginTop:8, color:'#667' }}>読み込み中…</p>}
    </div>
  );
}

/* utils */
function toYMD(d: Date) {
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth()+1}`.padStart(2,'0');
  const dd = `${d.getUTCDate()}`.padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
