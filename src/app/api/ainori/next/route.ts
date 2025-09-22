// src/app/api/ainori/next/route.ts
import { NextResponse } from 'next/server';

// 任意: Zoom情報を環境変数で（なくてもOK）
const AINORI_TITLE = process.env.AINORI_TITLE ?? '愛祈AINORI';
const AINORI_MEETING_NUMBER = process.env.AINORI_MEETING_NUMBER ?? '';
const AINORI_MEETING_PASSWORD = process.env.AINORI_MEETING_PASSWORD ?? '';
const AINORI_PAGE_URL = process.env.AINORI_PAGE_URL ?? ''; // 既に組込URLがある場合

// サーバー側から同一アプリ内の祝日APIを叩く（/api/jp-holiday?date=YYYY-MM-DD）
async function isJPHoliday(date: Date): Promise<boolean> {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? ''}/api/jp-holiday?date=${y}-${m}-${d}`, {
      // Next.js のランタイムでも同一ホストへ飛ばせる。環境によっては相対URLでもOK。
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const j = await res.json();
    return !!j?.holiday;
  } catch {
    return false;
  }
}

function atJST(y: number, m: number, d: number, hh = 0, mm = 0) {
  // JST固定のISOを作る（+09:00）
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00+09:00`;
}

export async function GET() {
  // 次回開催日: 「今日が平日・祝日でない かつ 6:30(JST)以前」なら今日、それ以外は次の平日
  const now = new Date(); // サーバーUTCでもOK、比較はJSTロジックで決定
  // 現地JSTに直感的に合わせるため、JSTの年月日・時刻を算出
  const nowJST = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  let y = nowJST.getUTCFullYear();
  let m = nowJST.getUTCMonth() + 1;
  let d = nowJST.getUTCDate();

  // ユーティリティ
  const toDate = (yy: number, mm: number, dd: number) =>
    new Date(Date.UTC(yy, mm - 1, dd, 0, 0, 0)); // 基準は日単位判定用
  const isSunday = (dt: Date) => dt.getUTCDay() === 0;

  // 「今日が対象日か」を判定
  let candidate = toDate(y, m, d);
  let holiday = await isJPHoliday(candidate);
  // JSTの 6:30 を過ぎていたら、今日分は不可
  const jst630 = new Date(Date.UTC(y, m - 1, d, -9 + 6, 30, 0)); // UTCに戻した 6:30 JST
  const before630 = now < jst630;

  const isValidToday = !isSunday(candidate) && !holiday && before630;

  // 今日が対象でなければ、次の平日（祝日でない日）まで進める
  while (!isValidToday) {
    // 翌日へ
    const next = new Date(candidate);
    next.setUTCDate(next.getUTCDate() + 1);
    candidate = next;
    holiday = await isJPHoliday(candidate);
    if (!isSunday(candidate) && !holiday) break;
  }

  // 開始は毎朝6:00 JST、所要は40分（05:50〜06:30の運用表記に合わせているため）
  const start_at = atJST(
    candidate.getUTCFullYear(),
    candidate.getUTCMonth() + 1,
    candidate.getUTCDate(),
    6,
    0
  );

  const body = {
    title: AINORI_TITLE,
    start_at,           // 例: 2025-09-23T06:00:00+09:00
    duration_min: 40,   // 05:50〜06:30 想定
    page_url: AINORI_PAGE_URL || undefined,
    meeting_number: AINORI_MEETING_NUMBER || undefined,
    meeting_password: AINORI_MEETING_PASSWORD || undefined,
  };

  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
