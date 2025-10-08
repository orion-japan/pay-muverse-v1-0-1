// src/app/api/ainori/next/route.ts
import { NextResponse } from 'next/server';

const AINORI_TITLE = process.env.AINORI_TITLE ?? '愛祈AINORI';
const AINORI_MEETING_NUMBER = process.env.AINORI_MEETING_NUMBER ?? '';
const AINORI_MEETING_PASSWORD = process.env.AINORI_MEETING_PASSWORD ?? '';
const AINORI_PAGE_URL = process.env.AINORI_PAGE_URL ?? '';

async function isJPHoliday(date: Date): Promise<boolean> {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  try {
    const base = process.env.NEXT_PUBLIC_BASE_URL ?? '';
    const res = await fetch(`${base}/api/jp-holiday?date=${y}-${m}-${d}`, { cache: 'no-store' });
    if (!res.ok) return false;
    const j = await res.json();
    return !!j?.holiday;
  } catch {
    return false;
  }
}

function atJST(y: number, m: number, d: number, hh = 0, mm = 0) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00+09:00`;
}

// ISO(+09:00) を Date(UTC) に
function isoJstToUTC(isoJst: string) {
  return new Date(isoJst); // ISOに+09:00を含めていれば自動でUTCに変換される
}

export async function GET() {
  const nowUTC = new Date();
  const nowJSTms = nowUTC.getTime() + 9 * 60 * 60 * 1000;
  const nowJST = new Date(nowJSTms);

  let y = nowJST.getUTCFullYear();
  let m = nowJST.getUTCMonth() + 1;
  let d = nowJST.getUTCDate();

  const toDate = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm - 1, dd, 0, 0, 0));
  const isSunday = (dt: Date) => dt.getUTCDay() === 0;

  let candidate = toDate(y, m, d);
  let holiday = await isJPHoliday(candidate);
  // JST 06:30 を UTC に変換（-9時間）
  const jst630utc = new Date(Date.UTC(y, m - 1, d, -3, 30, 0)); // 06:30 JST = 前日21:30UTC など
  const before630 = nowUTC < jst630utc;
  const isValidToday = !isSunday(candidate) && !holiday && before630;

  while (!isValidToday) {
    const next = new Date(candidate);
    next.setUTCDate(next.getUTCDate() + 1);
    candidate = next;
    holiday = await isJPHoliday(candidate);
    if (!isSunday(candidate) && !holiday) break;
  }

  // 本編 06:00 JST
  const start_at = atJST(
    candidate.getUTCFullYear(),
    candidate.getUTCMonth() + 1,
    candidate.getUTCDate(),
    6,
    0
  );

  // ――― 窓の定義（JST）
  // 「OPEN時間」= 05:50〜06:10（UI表示に合わせる）
  const open_from = atJST(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, candidate.getUTCDate(), 5, 50);
  const open_to   = atJST(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, candidate.getUTCDate(), 6, 10);

  // 「参加カウント窓」= 開始+10分の前後許容（±2分など）
  const join_from = atJST(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, candidate.getUTCDate(), 6, 8);
  const join_to   = atJST(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, candidate.getUTCDate(), 6, 12);

  // いずれも判定は UTC にしてから行う
  const nowUTCms = nowUTC.getTime();
  const is_open_window =
    nowUTCms >= isoJstToUTC(open_from).getTime() &&
    nowUTCms <= isoJstToUTC(open_to).getTime();

  const is_join_count_window =
    nowUTCms >= isoJstToUTC(join_from).getTime() &&
    nowUTCms <= isoJstToUTC(join_to).getTime();

  const body = {
    title: AINORI_TITLE,
    start_at,                 // 例: 2025-09-23T06:00:00+09:00
    duration_min: 40,
    page_url: AINORI_PAGE_URL || undefined,
    meeting_number: AINORI_MEETING_NUMBER || undefined,
    meeting_password: AINORI_MEETING_PASSWORD || undefined,

    // 追加（JST ISOで返す）
    open_from,
    open_to,
    join_from,
    join_to,
    now_jst: atJST(nowJST.getUTCFullYear(), nowJST.getUTCMonth() + 1, nowJST.getUTCDate(),
                   nowJST.getUTCHours(), nowJST.getUTCMinutes()),
    is_open_window,
    is_join_count_window,
  };

  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
