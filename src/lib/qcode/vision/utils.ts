// src/lib/vision/utils.ts
export const JST_OFFSET_MS = 9 * 3600 * 1000;

export function toJstDate(d = new Date()) {
  return new Date(d.getTime() + JST_OFFSET_MS);
}
export function fmtJst(d = new Date()) {
  const x = toJstDate(d);
  const y = x.getUTCFullYear();
  const m = String(x.getUTCMonth() + 1).padStart(2, '0');
  const day = String(x.getUTCDate()).padStart(2, '0');
  const hh = String(x.getUTCHours()).padStart(2, '0');
  const mm = String(x.getUTCMinutes()).padStart(2, '0');
  return `${y}/${m}/${day} ${hh}:${mm}`;
}
/** "YYYY-MM-DD"（JSTのその日の0:00〜翌0:00） */
export function jstDayWindow(ymd?: string) {
  const base = ymd
    ? new Date(`${ymd}T00:00:00+09:00`)
    : toJstDate(new Date(new Date().toISOString()));
  const start = new Date(base);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    for_date: start.toISOString().slice(0, 10),
  };
}
/** JSTの「今日」のYYYY-MM-DD */
export function todayJst() {
  return jstDayWindow().for_date;
}
/** 連続日数を数える（降順でday配列が入っている想定） */
export function countStreak(daysSet: Set<string>, horizon = 14) {
  let streak = 0;
  for (let i = 0; i < horizon; i++) {
    const d = new Date(Date.now() + JST_OFFSET_MS);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (daysSet.has(key)) streak++;
    else break;
  }
  return streak;
}
