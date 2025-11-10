// 共鳴会のQコード 生成ロジック（新規カラムなし版）
import { supabaseAdmin } from '@/lib/supabaseAdmin';

type WindowMetrics = {
  attRate: number; // 出席率 0..1
  trendLast5: number; // 直近5回の平均（出席=1 欠席=0）
  cvIntervals: number | null; // 出席日の間隔 変動係数（null=出席1回以下）
  streakAttend: number; // 連続出席
  streakAbsent: number; // 連続欠席
  expected: number; // 期間内の開催数
  attended: number; // 期間内の出席数
  missed: number; // 期間内の欠席数
};

export type KyomeikaiQResult = {
  q: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  confidence: number;
  hint: string;
  color_hex: string;
  meta: {
    window: '7d';
    att_rate: number;
    streak_absent: number;
    streak_attend: number;
    trend_last5: number;
    balance7d: number;
    expected_events: number;
    attended: number;
    missed: number;
    for_date: string; // YYYY-MM-DD (JST)
    is_present: boolean;
  };
};

// ★ あなたの実テーブル名に合わせて調整してください
const T_SCHEDULES = 'event_schedules'; // 開催定義: {event_id, date, ...}
const T_ATTENDS = 'attendance_checkins'; // 出席ログ: {user_code, event_id, checked_at}

const EVENT_ID = 'kyomeikai';

function qColor(q: KyomeikaiQResult['q']) {
  switch (q) {
    case 'Q1':
      return '#E0F2FE';
    case 'Q2':
      return '#DCFCE7';
    case 'Q3':
      return '#FEF3C7';
    case 'Q4':
      return '#FEE2E2';
    case 'Q5':
      return '#EDE9FE';
  }
}

function pickQ(
  metrics: WindowMetrics,
  isPresentToday: boolean,
): { q: KyomeikaiQResult['q']; confidence: number; hint: string } {
  const balance =
    0.6 * metrics.attRate +
    0.2 * (metrics.cvIntervals == null ? 1 : Math.max(0, Math.min(1, 1 - metrics.cvIntervals))) +
    0.2 * metrics.trendLast5;

  let q: KyomeikaiQResult['q'];
  if (metrics.streakAbsent >= 3 && isPresentToday) {
    q = 'Q5'; // 連欠→復帰は転機扱い
  } else if (balance >= 0.8 && metrics.streakAbsent === 0) {
    q = 'Q2';
  } else if (balance >= 0.55) {
    q = 'Q1';
  } else if (balance >= 0.35) {
    q = 'Q3';
  } else {
    q = 'Q4';
  }

  // 少しだけランダム揺らし（±1段階まで、Q2↔Q4跨ぎはしない）
  if (Math.random() < 0.12) {
    const order: KyomeikaiQResult['q'][] = ['Q2', 'Q1', 'Q3', 'Q4']; // Q5は特例のため除外
    const idx = order.indexOf(q);
    if (idx >= 0) {
      const delta = Math.random() < 0.5 ? -1 : 1;
      const ni = Math.max(0, Math.min(order.length - 1, idx + delta));
      // Q2→Q4, Q4→Q2 のジャンプ禁止
      if (!(q === 'Q2' && order[ni] === 'Q4') && !(q === 'Q4' && order[ni] === 'Q2')) {
        q = order[ni];
      }
    }
  }

  const conf = q === 'Q2' ? 0.75 : q === 'Q1' ? 0.65 : q === 'Q3' ? 0.6 : q === 'Q4' ? 0.7 : 0.72;

  const hint = `出席率${metrics.attRate.toFixed(2)} / 欠席連続${metrics.streakAbsent} / 直近トレンド${metrics.trendLast5.toFixed(2)} / balance${balance.toFixed(2)}`;

  return { q, confidence: conf, hint };
}

function jstDateString(d: Date) {
  // JSTで YYYY-MM-DD
  const t = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return t.toISOString().slice(0, 10);
}

async function getScheduleDates(fromIso: string, toIso: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from(T_SCHEDULES)
    .select('date')
    .eq('event_id', EVENT_ID)
    .gte('date', fromIso)
    .lte('date', toIso);

  if (error) throw error;
  return (data ?? []).map((r) => r.date);
}

async function getUserAttendanceDates(
  user_code: string,
  fromIso: string,
  toIso: string,
): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from(T_ATTENDS)
    .select('checked_at')
    .eq('event_id', EVENT_ID)
    .eq('user_code', user_code)
    .gte('checked_at', fromIso + ' 00:00:00+09')
    .lte('checked_at', toIso + ' 23:59:59+09');

  if (error) throw error;
  const set = new Set<string>();
  (data ?? []).forEach((r) => set.add(jstDateString(new Date(r.checked_at))));
  return Array.from(set);
}

// 直近N回（開催）に対して 1/0 の平均
function trendLastN(schedulesAsc: string[], presentSet: Set<string>, N = 5): number {
  const lastN = schedulesAsc.slice(-N);
  if (lastN.length === 0) return 0;
  const arr = lastN.map((d) => Number(presentSet.has(d))); // ← 型を number[] に
  const avg = arr.reduce((sum, v) => sum + v, 0) / arr.length;
  return avg;

}

// 出席日の間隔（差分日数）の変動係数（std/mean）
function cvIntervals(presentDatesAsc: string[]): number | null {
  if (presentDatesAsc.length <= 2) return null;
  const nums = presentDatesAsc.map((d) => new Date(d).getTime() / 86400000);
  const diffs: number[] = [];
  for (let i = 1; i < nums.length; i++) diffs.push(nums[i] - nums[i - 1]);
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / diffs.length;
  const sd = Math.sqrt(variance);
  if (mean === 0) return 0;
  return sd / mean;
}

function streakFromTail(
  schedulesAsc: string[],
  presentSet: Set<string>,
  type: 'attend' | 'absent',
): number {
  let s = 0;
  for (let i = schedulesAsc.length - 1; i >= 0; i--) {
    const day = schedulesAsc[i];
    const isAttend = presentSet.has(day);
    if ((type === 'attend' && isAttend) || (type === 'absent' && !isAttend)) {
      s++;
    } else {
      break;
    }
  }
  return s;
}

/**
 * 指定日の “日Q” を計算し、結果オブジェクトを返す（DB書き込みはしない）。
 */
export async function calcKyomeikaiQForDate(
  user_code: string,
  forDateIso: string,
): Promise<KyomeikaiQResult> {
  // 7日窓
  const from7 = jstDateString(new Date(new Date(forDateIso).getTime() - 6 * 86400000));
  const to7 = forDateIso;

  const schedules7 = await getScheduleDates(from7, to7);
  schedules7.sort();
  const expected7 = schedules7.length;

  const presentDates7 = await getUserAttendanceDates(user_code, from7, to7);
  const presentSet7 = new Set(presentDates7);
  const attended7 = presentDates7.filter((d) => schedules7.includes(d)).length;
  const missed7 = expected7 - attended7;

  const attRate7 = expected7 > 0 ? attended7 / expected7 : 0;
  const trend5 = trendLastN(schedules7, presentSet7, 5);
  const cvInt = cvIntervals(presentDates7.sort());
  const stAttend = streakFromTail(schedules7, presentSet7, 'attend');
  const stAbsent = streakFromTail(schedules7, presentSet7, 'absent');

  // 当日が開催日かつ出席か
  const isPresentToday = presentSet7.has(forDateIso) && schedules7.includes(forDateIso);

  const { q, confidence, hint } = pickQ(
    {
      attRate: attRate7,
      trendLast5: trend5,
      cvIntervals: cvInt,
      streakAttend: stAttend,
      streakAbsent: stAbsent,
      expected: expected7,
      attended: attended7,
      missed: missed7,
    },
    isPresentToday,
  );

  const color_hex = qColor(q);

  return {
    q,
    confidence,
    hint,
    color_hex,
    meta: {
      window: '7d',
      att_rate: Number(attRate7.toFixed(4)),
      streak_absent: stAbsent,
      streak_attend: stAttend,
      trend_last5: Number(trend5.toFixed(4)),
      balance7d: Number(
        (
          0.6 * attRate7 +
          0.2 * (cvInt == null ? 1 : Math.max(0, Math.min(1, 1 - cvInt))) +
          0.2 * trend5
        ).toFixed(4),
      ),
      expected_events: expected7,
      attended: attended7,
      missed: missed7,
      for_date: forDateIso,
      is_present: isPresentToday,
    },
  };
}
