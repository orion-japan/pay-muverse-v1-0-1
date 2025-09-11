// src/lib/date.ts
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

// 既定タイムゾーンをJSTに固定
dayjs.tz.setDefault('Asia/Tokyo');

// 表示用フォーマッタ（共通で使う）
export function formatJST(input?: string | Date | number, fmt = 'YYYY-MM-DD HH:mm') {
  if (!input) return '';
  return dayjs(input).tz().format(fmt); // 常にJSTで出力
}

// その日のJST境界（DBクエリ用）
export function jstDayRange(date: string | Date | number) {
  const startJ = dayjs(date).tz().startOf('day');
  const endJ   = dayjs(date).tz().endOf('day');
  // DBがUTC保存(timestamptz)の場合、UTCに変換して境界を作る
  return {
    startUtcISO: startJ.utc().toISOString(),
    endUtcISO: endJ.utc().toISOString(),
  };
}

// n日移動（スワイプで使用）
export function shiftDays(date: string | Date, n: number) {
  return dayjs(date).tz().add(n, 'day').toDate();
}

export { dayjs };
