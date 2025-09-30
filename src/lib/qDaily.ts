// サーバー専用ユーティリティ
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export type QDailyRow = {
  user_code: string
  day_jst: string // 'YYYY-MM-DD'
  q: 'Q1'|'Q2'|'Q3'|'Q4'|'Q5'
  q_count: number
}

/**
 * 指定ユーザーの、日別Q分布（正規化済: 同日×intentは最新のみ）
 */
export async function fetchQDaily(userCode: string, from?: string, to?: string) {
  let q = supabase
    .from('mv_user_q_daily_latest_per_intent')
    .select('*')
    .eq('user_code', userCode)
    .order('day_jst', { ascending: false }) as any

  if (from) q = q.gte('day_jst', from)
  if (to)   q = q.lte('day_jst', to)

  const { data, error }:{ data: QDailyRow[]|null, error: any } = await q
  if (error) throw error

  return data ?? []
}

/**
 * 表示用にピボット（同じ日付のQ1〜Q5を横持ちに）
 */
export function pivotDaily(rows: QDailyRow[]) {
  const map: Record<string, { day: string; Q1:number; Q2:number; Q3:number; Q4:number; Q5:number; total:number }> = {}
  for (const r of rows) {
    const key = r.day_jst
    if (!map[key]) map[key] = { day: key, Q1:0, Q2:0, Q3:0, Q4:0, Q5:0, total:0 }
    map[key][r.q] += r.q_count
    map[key].total += r.q_count
  }
  return Object.values(map).sort((a,b)=> (a.day < b.day ? 1 : -1))
}

/**
 * 代表Q（最多）を決める（同数タイは Q3>Q2>Q1>Q4>Q5 の優先）
 */
export function pickRepresentativeQ(p: {Q1:number;Q2:number;Q3:number;Q4:number;Q5:number}) {
  const order: Array<keyof typeof p> = ['Q3','Q2','Q1','Q4','Q5']
  let best = order[0]
  for (const q of order) if (p[q] > p[best]) best = q
  return best
}
