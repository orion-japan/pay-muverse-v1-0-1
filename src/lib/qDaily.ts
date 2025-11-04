// src/lib/qcode/qDaily.ts
// サーバー専用ユーティリティ（※ pages/api や server components からのみ import）
// Service Role を使うので、絶対にクライアント側からは import しないこと！
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!URL || !SERVICE_KEY) {
  throw new Error('Supabase env missing: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
}

function serverSupabase(): SupabaseClient {
  // 毎回新規でもOK。高頻度ならモジュールスコープの単一インスタンスでも可
  return createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export type QDailyRow = {
  user_code: string;
  day_jst: string; // 'YYYY-MM-DD'
  q: QCode;
  q_count: number;
};

/**
 * 指定ユーザーの、日別Q分布（正規化済: 同日×intentは最新のみ）
 * - 期間フィルタ: from/to（JST日付文字列）
 * - 任意で source_type / intent でも絞り込める（将来の用途）
 */
export async function fetchQDaily(
  userCode: string,
  opts?: {
    from?: string;
    to?: string;
    source_types?: string[]; // 例: ['self','event','invite']
    intents?: string[]; // 例: ['habit','check','create']
    limit?: number; // 表示の上限
    asc?: boolean; // 並び
  },
): Promise<QDailyRow[]> {
  const supabase = serverSupabase();
  const { from, to, source_types, intents, limit, asc = false } = opts ?? {};

  let q = supabase
    .from('mv_user_q_daily_latest_per_intent')
    .select('*')
    .eq('user_code', userCode)
    .order('day_jst', { ascending: asc }) as any;

  if (from) q = q.gte('day_jst', from);
  if (to) q = q.lte('day_jst', to);
  if (source_types?.length) q = q.in('source_type', source_types);
  if (intents?.length) q = q.in('intent', intents);
  if (limit) q = q.limit(limit);

  const { data, error }: { data: QDailyRow[] | null; error: any } = await q;
  if (error) throw error;

  return data ?? [];
}

/** 直近N日（JST）の Q を取得するショートカット */
export async function fetchQDailyLastNDays(
  userCode: string,
  days: number,
  extra?: Omit<Parameters<typeof fetchQDaily>[1], 'from' | 'to'>,
) {
  const today = new Date();
  const utc = today.getTime() + today.getTimezoneOffset() * 60000;
  const jst = new Date(utc + 9 * 60 * 60000);
  const to = jst.toISOString().slice(0, 10);
  const fromDate = new Date(jst);
  fromDate.setDate(fromDate.getDate() - (days - 1));
  const from = fromDate.toISOString().slice(0, 10);
  return fetchQDaily(userCode, { from, to, ...(extra ?? {}) });
}

/** 表示用にピボット（同じ日付のQ1〜Q5を横持ちに） */
export type PivotRow = {
  day: string;
  Q1: number;
  Q2: number;
  Q3: number;
  Q4: number;
  Q5: number;
  total: number;
};

export function pivotDaily(rows: QDailyRow[]): PivotRow[] {
  const map: Record<string, PivotRow> = {};
  for (const r of rows) {
    const key = r.day_jst;
    if (!map[key]) map[key] = { day: key, Q1: 0, Q2: 0, Q3: 0, Q4: 0, Q5: 0, total: 0 };
    // r.q は 'Q1'|'Q2'|'Q3'|'Q4'|'Q5' なので、型を狭めて安全に加算
    (map[key][r.q] as number) += r.q_count;
    map[key].total += r.q_count;
  }
  // 新しい日付が先に来るように降順
  return Object.values(map).sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** 代表Q（最多）を決める（同数タイは Q3>Q2>Q1>Q4>Q5 の優先） */
export function pickRepresentativeQ(p: {
  Q1: number;
  Q2: number;
  Q3: number;
  Q4: number;
  Q5: number;
}): QCode {
  const order: QCode[] = ['Q3', 'Q2', 'Q1', 'Q4', 'Q5'];
  let best: QCode = order[0];
  for (const q of order) if (p[q] > p[best]) best = q;
  return best;
}
