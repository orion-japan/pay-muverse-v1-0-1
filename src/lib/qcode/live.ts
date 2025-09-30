// 不定期開催の LIVE 用 Q コード算出
// 参加密度（14/30日）、直近性（最後の参加からの経過日）、間隔の乱れ（CV）で判定
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export type LiveQResult = {
  q: 'Q1'|'Q2'|'Q3'|'Q4'|'Q5';
  confidence: number;
  hint: string;
  color_hex: string;
  meta: {
    window: '14d/30d';
    joins_14d: number;
    joins_30d: number;
    last_join_days_ago: number | null;
    cv_intervals: number | null;   // 参加日のインターバルの変動係数（小さいほどリズム安定）
    activity_score: number;        // 0..1
    for_date: string;              // YYYY-MM-DD (JST)
    is_join_today: boolean;
  };
};

const EVENT_ID = 'live';

function qColor(q: LiveQResult['q']) {
  switch (q) {
    case 'Q1': return '#E0F2FE';
    case 'Q2': return '#DCFCE7';
    case 'Q3': return '#FEF3C7';
    case 'Q4': return '#FEE2E2';
    case 'Q5': return '#EDE9FE';
  }
}

function jstDate(d: Date) {
  const t = new Date(d.getTime() + 9*3600*1000);
  return t.toISOString().slice(0,10);
}

async function getJoinDates(user_code:string, fromIso:string, toIso:string):Promise<string[]>{
  const { data, error } = await supabaseAdmin
    .from('attendance_checkins')
    .select('checked_at')
    .eq('event_id', EVENT_ID)
    .eq('user_code', user_code)
    .gte('checked_at', fromIso + ' 00:00:00+09')
    .lte('checked_at', toIso   + ' 23:59:59+09');

  if (error) throw error;
  const set = new Set<string>();
  (data ?? []).forEach(r => set.add(jstDate(new Date(r.checked_at))));
  return Array.from(set).sort();
}

function daysBetween(a:string, b:string){ // YYYY-MM-DD
  return Math.round(
    (new Date(b+'T00:00:00+09:00').getTime() - new Date(a+'T00:00:00+09:00').getTime())
    / 86400000
  );
}

// 参加日のインターバル（差分日数）の変動係数（std/mean）
function cvIntervals(datesAsc:string[]): number | null {
  if (datesAsc.length <= 2) return null;
  const nums = datesAsc.map(d => new Date(d+'T00:00:00+09:00').getTime()/86400000);
  const diffs:number[] = [];
  for (let i=1;i<nums.length;i++) diffs.push(nums[i]-nums[i-1]);
  const mean = diffs.reduce((a,b)=>a+b,0)/diffs.length;
  const variance = diffs.reduce((a,b)=>a+(b-mean)**2,0)/diffs.length;
  const sd = Math.sqrt(variance);
  if (mean === 0) return 0;
  return sd/mean;
}

/**
 * LIVE の “日Q” を計算（DB書き込みはしない）
 * - 不定期なので「来なかった日」を減点せず、参加活動の密度と直近性を評価。
 */
export async function calcLiveQForDate(user_code:string, forDateIso:string):Promise<LiveQResult>{
  const from14 = jstDate(new Date(new Date(forDateIso).getTime() - 13*86400000));
  const from30 = jstDate(new Date(new Date(forDateIso).getTime() - 29*86400000));

  const joins14 = await getJoinDates(user_code, from14, forDateIso);
  const joins30 = await getJoinDates(user_code, from30, forDateIso);

  const joins14Count = joins14.length;
  const joins30Count = joins30.length;

  const isJoinToday = joins14.includes(forDateIso);

  // 直近性：最後の参加から何日か
  const lastDate = joins30.length ? joins30[joins30.length-1] : null;
  const lastJoinDaysAgo = lastDate ? daysBetween(lastDate, forDateIso) : null;

  // 間隔の乱れ
  const cv = cvIntervals(joins30);

  // 活動スコア（0..1）
  // 目安：14日で3回, 30日で6回を上限にクランプ、直近性は τ=7日の指数減衰、CVは小さいほど高得点
  const dens14 = Math.min(1, joins14Count / 3);
  const dens30 = Math.min(1, joins30Count / 6);
  const recency = lastJoinDaysAgo == null ? 0 : Math.exp(-(lastJoinDaysAgo)/7); // 0..1
  const rhythm  = cv == null ? 1 : Math.max(0, Math.min(1, 1 - cv));            // 0..1

  const activity = +(0.45*dens14 + 0.25*dens30 + 0.20*recency + 0.10*rhythm).toFixed(4);

  // Q 決定
  let q: LiveQResult['q'];
  if (isJoinToday && lastJoinDaysAgo !== null && lastJoinDaysAgo >= 14) {
    q = 'Q5'; // しばらくぶりの復帰は転機
  } else if (activity >= 0.8) {
    q = 'Q2';
  } else if (activity >= 0.55) {
    q = 'Q1';
  } else if (activity >= 0.35) {
    q = 'Q3';
  } else {
    q = 'Q4';
  }

  // 軽いランダム揺らし（±1段階、Q2↔Q4のジャンプは抑止）
  if (Math.random() < 0.12) {
    const order: LiveQResult['q'][] = ['Q2','Q1','Q3','Q4'];
    const idx = order.indexOf(q);
    if (idx >= 0) {
      const ni = Math.max(0, Math.min(order.length-1, idx + (Math.random()<0.5?-1:1)));
      if (!(q==='Q2' && order[ni]==='Q4') && !(q==='Q4' && order[ni]==='Q2')) q = order[ni];
    }
  }

  const confidence =
    q==='Q2' ? 0.72 :
    q==='Q1' ? 0.65 :
    q==='Q3' ? 0.60 :
    q==='Q4' ? 0.70 : 0.70;

  const hint =
    `14d:${joins14Count}回 / 30d:${joins30Count}回 / last:${lastJoinDaysAgo ?? '—'}日 / act:${activity}`;

  return {
    q,
    confidence,
    hint,
    color_hex: qColor(q),
    meta: {
      window: '14d/30d',
      joins_14d: joins14Count,
      joins_30d: joins30Count,
      last_join_days_ago: lastJoinDaysAgo,
      cv_intervals: cv,
      activity_score: activity,
      for_date: forDateIso,
      is_join_today: isJoinToday,
    }
  };
}
