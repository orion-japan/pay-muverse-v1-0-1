// app/api/qcode/log/route.ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';

type Q = 'Q1'|'Q2'|'Q3'|'Q4'|'Q5';
type QCode = { currentQ: Q; depthStage?: string } & Record<string, any>;

/* ===== 日付ヘルパー（JSTで“日付だけ”扱う） ===== */
const JST_OFFSET_MIN = 9 * 60;

/** 'YYYY-MM-DD' → Date（ローカル日付をUTCの 00:00 として扱う） */
function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  // 月は0始まり
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
}
/** Date → 'YYYY-MM-DD'（JST基準で日付だけ） */
function toJstYmd(d: Date): string {
  // d はUTC基準。JSTでの“日付”を算出
  const ms = d.getTime() + JST_OFFSET_MIN * 60_000;
  const j = new Date(ms);
  const y = j.getUTCFullYear();
  const m = String(j.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(j.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
/** 日数加減（UTC基準） */
function addDaysUTC(d: Date, n: number): Date {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
/** 包含区間の“日数” */
function inclusiveDays(a: Date, b: Date): number {
  const MS = 86_400_000;
  return Math.floor((b.getTime() - a.getTime()) / MS) + 1;
}

/* ================================================= */

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const user_code = searchParams.get('user_code') ?? undefined;
  const intent = searchParams.get('intent') ?? undefined; // 'all' | 'manual' | 'auto' など
  const days = Number(searchParams.get('days') ?? '30');
  const limit = Math.min(Number(searchParams.get('limit') ?? '500'), 2000);
  const fromQ = searchParams.get('from'); // 'YYYY-MM-DD'
  const toQ   = searchParams.get('to');   // 'YYYY-MM-DD'

  // ★ cookies() はコールバックで渡す（Nextの同期API警告を回避）
  const supabase = createRouteHandlerClient({ cookies: () => cookies() });

  // 期間の決定（JSTで“日付だけ”）
  const today = new Date();               // 現在UTC
  const endDate = toQ ? parseYmd(toQ.replace(/\//g, '-')) : parseYmd(toJstYmd(today));
  // days 指定時は「包含で days 日」になるよう start = end - (days-1)
  const startDate = fromQ
    ? parseYmd(fromQ.replace(/\//g, '-'))
    : addDaysUTC(endDate, -Math.max(1, isFinite(days) ? days : 30) + 1);

  const fromStr = toJstYmd(startDate);
  const toStr   = toJstYmd(endDate);
  const daysSpan = inclusiveDays(startDate, endDate);

  // クエリ（for_date は DATE 型を想定。inclusive で gte/lte）
  let q = supabase
    .from('q_code_logs')
    .select('for_date,user_code,q_code,intent,extra', { count: 'exact' })
    .gte('for_date', fromStr)
    .lte('for_date', toStr)
    .order('for_date', { ascending: false })
    .limit(limit);

  if (user_code) q = q.eq('user_code', user_code);
  if (intent && intent !== 'all') q = q.eq('intent', intent);

  const { data, error, count } = await q;
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 400 }
    );
  }

  // currentQ を持つレコードのみ返す（古いデータ互換）
  const items = (data ?? []).filter(r => r?.q_code?.currentQ);

  return NextResponse.json({
    ok: true,
    range: { from: fromStr, to: toStr, days: daysSpan, total_rows: count ?? items.length },
    items,
  });
}

export async function POST(req: Request) {
  const supabase = createRouteHandlerClient({ cookies: () => cookies() });
  const body = await req.json().catch(() => ({}));

  const { user_code, q, stage, q_code, intent, seed_id, for_date, extra } = body ?? {};

  let qc: QCode | null = null;
  if (q_code && typeof q_code === 'object') qc = q_code;
  else if (q && stage) qc = { currentQ: q, depthStage: stage };

  if (!user_code || !qc?.currentQ) {
    return NextResponse.json(
      { ok: false, error: 'user_code と q_code(currentQ) は必須です' },
      { status: 400 }
    );
  }

  // for_date は 'YYYY-MM-DD' 前提。未指定なら“今日(JST)”の日付文字列。
  const forDateStr =
    typeof for_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(for_date)
      ? for_date
      : toJstYmd(new Date());

  const payload = {
    user_code,
    q_code: qc,
    intent: intent ?? 'manual',
    seed_id: seed_id ?? null,
    for_date: forDateStr,
    extra: extra ?? null,
  };

  const { data, error } = await supabase
    .from('q_code_logs')
    .insert(payload)
    .select()
    .single();

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true, item: data });
}
