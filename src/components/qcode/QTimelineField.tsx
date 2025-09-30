// src/components/qcode/QTimelineField.tsx
'use client';
import React, { useMemo } from 'react';

type Q = 'Q1'|'Q2'|'Q3'|'Q4'|'Q5';
type Pol = 'ease'|'now'|'yin'|'yang'|undefined;
type QLog = {
  for_date: string;
  q_code?: { currentQ?: Q; polarity?: Pol };
};

const BASE: Record<Q, string> = {
  Q1:'#7b8da4', Q2:'#5aa06a', Q3:'#c2a05a', Q4:'#5a88c2', Q5:'#c25a5a'
};

/* --- utils --- */
const normYMD = (s: string) => s?.trim().slice(0,10);                // 'YYYY-MM-DD'
const toUTCDate = (ymd: string) => {
  const [y,m,d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1)-1, d ?? 1));
};
const isYYYYMM = (s?: string) => !!s && /^\d{4}-\d{2}$/.test(s);
const isYYYYMMDD = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const monthRange = (yyyyMm: string) => {
  const [y,m] = yyyyMm.split('-').map(Number);
  const s = new Date(Date.UTC(y,(m??1)-1,1));
  const e = new Date(Date.UTC(y,(m??1),0));
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  return { start: fmt(s), end: fmt(e) };
};

/* 色生成 */
function hexToHsl(hex:string){const n=hex.replace('#','');const r=parseInt(n.slice(0,2),16)/255;
const g=parseInt(n.slice(2,4),16)/255;const b=parseInt(n.slice(4,6),16)/255;
const max=Math.max(r,g,b),min=Math.min(r,g,b);let h=0,s=0,l=(max+min)/2;
if(max!==min){const d=max-min;s=l>0.5?d/(2-max-min):d/(max+min);
switch(max){case r:h=(g-b)/d+(g<b?6:0);break;case g:h=(b-r)/d+2;break;case b:h=(r-g)/d+4;break}h/=6}
return{h:h*360,s:s*100,l:l*100}}
function hslToHex(h:number,s:number,l:number){h/=360;s/=100;l/=100;
const f=(p:number,q:number,t:number)=>{if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return p+(q-p)*6*t;
if(t<1/2)return q;if(t<2/3)return p+(q-p)*(2/3-t)*6;return p};let r,g,b;
if(s===0){r=g=b=l}else{const q=l<0.5?l*(1+s):l+s-l*s;const p=2*l-q;
r=f(p,q,h+1/3);g=f(p,q,h);b=f(p,q,h-1/3)}const to=(x:number)=>Math.round(x*255).toString(16).padStart(2,'0');
return `#${to(r)}${to(g)}${to(b)}`}
const easeColor=(hex:string)=>{const {h,s,l}=hexToHsl(hex);return hslToHex(h,Math.min(100,s+25),Math.min(95,l+25))};
const nowColor =(hex:string)=>{const {h,s,l}=hexToHsl(hex);return hslToHex(h,Math.max(0,s-20),Math.max(0,l-20))};

export default function TimelineField({
  items,
  days,
  startDate,
  endDate,
}: {
  items: QLog[];
  days?: '30'|'60'|'90';
  startDate?: string;   // 'YYYY-MM' or 'YYYY-MM-DD'
  endDate?: string;     // 'YYYY-MM' or 'YYYY-MM-DD'
}) {
  /* 代表色（同日複数は最後のログが勝つ） */
  const dayColors = useMemo(() => {
    const map: Record<string,string> = {};
    for (const it of items) {
      const key = normYMD(it.for_date);
      if (!key) continue;
      const q = it.q_code?.currentQ;
      if (!q) continue;
      const pol = it.q_code?.polarity === 'ease' ? 'ease' : 'now';
      map[key] = pol==='ease' ? easeColor(BASE[q]) : nowColor(BASE[q]);
    }
    return map;
  }, [items]);

  /* 期間決定 */
  let s = startDate, e = endDate;
  if (isYYYYMM(s) && !e) { const r = monthRange(s!); s = r.start; e = r.end; }
  if (isYYYYMM(e) && !s) { const r = monthRange(e!); s = r.start; e = r.end; }

  let start: Date, end: Date;
  if (isYYYYMMDD(s) && isYYYYMMDD(e)) {
    start = toUTCDate(s!); end = toUTCDate(e!);
  } else if (days) {
    const today = new Date();
    end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    start = new Date(end); start.setUTCDate(end.getUTCDate() - (parseInt(days)-1));
  } else if (items.length) {
    const times = items.map(i => toUTCDate(normYMD(i.for_date)!).getTime());
    start = new Date(Math.min(...times)); end = new Date(Math.max(...times));
  } else {
    const today = new Date();
    start = end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  }
  if (start.getTime() > end.getTime()) { const t = start; start = end; end = t; }

  /* リスト生成（両端含む） */
  const list: string[] = [];
  const cur = new Date(start);
  while (cur.getTime() <= end.getTime()) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth()+1).padStart(2,'0');
    const d = String(cur.getUTCDate()).padStart(2,'0');
    list.push(`${y}-${m}-${d}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return (
    <div style={{
      display:'flex', gap:2, height:160,
      borderRadius:10, overflow:'hidden',
      background:'linear-gradient(180deg, rgba(0,0,0,0.04), rgba(0,0,0,0))'
    }}>
      {list.map(d=>(
        <div key={d} style={{
          flex:1,
          background: dayColors[d] ?? '#e9edf4',
          borderRight:'1px solid rgba(255,255,255,0.6)'
        }}/>
      ))}
    </div>
  );
}
