import { supabaseAdmin } from '@/lib/supabaseAdmin';

type WindowMetrics = {
  attRate7: number;
  attRate30: number;
  streakAttend: number;
  streakAbsent: number;
};

export type AinoriQResult = {
  q: 'Q1'|'Q2'|'Q3'|'Q4'|'Q5';
  confidence: number;
  hint: string;
  color_hex: string;
  meta: {
    window: '7d/30d';
    att_rate_7d: number;
    att_rate_30d: number;
    streak_attend: number;
    streak_absent: number;
    for_date: string;
    is_present: boolean;
    checkin_time?: string|null; // 実際の打刻時刻
  };
};

const EVENT_ID = 'ainori';

function qColor(q: AinoriQResult['q']) {
  switch (q) {
    case 'Q1': return '#E0F2FE';
    case 'Q2': return '#DCFCE7';
    case 'Q3': return '#FEF3C7';
    case 'Q4': return '#FEE2E2';
    case 'Q5': return '#EDE9FE';
  }
}

// 判定ロジック
function pickQ(m: WindowMetrics, isPresentToday: boolean): { q: AinoriQResult['q']; confidence: number; hint: string } {
  if (m.streakAttend >= 5) return { q:'Q2', confidence:0.8, hint:'連続参加で安定' };
  if (m.streakAbsent >= 5) return { q:'Q4', confidence:0.75, hint:'連続欠席で停滞' };

  if (m.attRate7 >= 0.7) return { q:'Q2', confidence:0.7, hint:'7日出席率高め' };
  if (m.attRate30 >= 0.5) return { q:'Q1', confidence:0.65, hint:'30日ベースで安定' };
  if (m.attRate7 <= 0.3) return { q:'Q3', confidence:0.6, hint:'直近参加が減少' };

  // 欠席から復帰した当日は転機扱い
  if (isPresentToday && m.streakAbsent >= 2) return { q:'Q5', confidence:0.7, hint:'欠席明けの復帰' };

  return { q:'Q1', confidence:0.6, hint:'平均的な参加パターン' };
}

function jstDateString(d: Date) {
  const t = new Date(d.getTime() + 9 * 3600 * 1000);
  return t.toISOString().slice(0,10);
}

async function getAttendDates(user_code:string, fromIso:string, toIso:string):Promise<{date:string, time:string}[]> {
  const { data, error } = await supabaseAdmin
    .from('attendance_checkins')
    .select('checked_at')
    .eq('event_id', EVENT_ID)
    .eq('user_code', user_code)
    .gte('checked_at', fromIso+' 00:00:00+09')
    .lte('checked_at', toIso+' 23:59:59+09');

  if (error) throw error;
  return (data ?? []).map(r=>{
    const d = new Date(r.checked_at);
    return { date:jstDateString(d), time:d.toISOString().slice(11,19) };
  });
}

function streak(dates:string[], presentSet:Set<string>, type:'attend'|'absent'):number {
  let s=0;
  for(let i=dates.length-1;i>=0;i--){
    const dd=dates[i];
    const attend=presentSet.has(dd);
    if((type==='attend'&&attend)||(type==='absent'&&!attend)) s++; else break;
  }
  return s;
}

export async function calcAinoriQForDate(user_code:string, forDateIso:string):Promise<AinoriQResult>{
  const from7=jstDateString(new Date(new Date(forDateIso).getTime()-6*86400000));
  const from30=jstDateString(new Date(new Date(forDateIso).getTime()-29*86400000));

  const att7=await getAttendDates(user_code,from7,forDateIso);
  const att30=await getAttendDates(user_code,from30,forDateIso);
  const set7=new Set(att7.map(r=>r.date));
  const set30=new Set(att30.map(r=>r.date));

  const attRate7=att7.length/7;
  const attRate30=att30.length/30;

  const allDates=[];for(let i=0;i<30;i++){allDates.push(jstDateString(new Date(new Date(forDateIso).getTime()-i*86400000)));}
  allDates.reverse();

  const streakAttend=streak(allDates,set30,'attend');
  const streakAbsent=streak(allDates,set30,'absent');

  const isPresentToday=set7.has(forDateIso);
  const todayCheck=att7.find(r=>r.date===forDateIso);

  const pick=pickQ({attRate7,attRate30,streakAttend,streakAbsent},isPresentToday);
  return {
    q:pick.q,
    confidence:pick.confidence,
    hint:pick.hint,
    color_hex:qColor(pick.q),
    meta:{
      window:'7d/30d',
      att_rate_7d:attRate7,
      att_rate_30d:attRate30,
      streak_attend:streakAttend,
      streak_absent:streakAbsent,
      for_date:forDateIso,
      is_present:isPresentToday,
      checkin_time:todayCheck?.time||null
    }
  };
}
