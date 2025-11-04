export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/q/daily_with_carry?days=30 | &start=YYYY-MM-DD&end=YYYY-MM-DD
 * （オプション）&user=xxxx は必要なら /api/qcode/log 側に伝播
 *
 * 戻り:
 * [{ date:'YYYY-MM-DD', q1:number, q2:number, q3:number, q4:number, q5:number }, ...]
 *  ※「キャリー」は可視化専用の概念なので、ここは “実記録のみ” を集計
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const days = url.searchParams.get('days');
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  const user = url.searchParams.get('user') ?? undefined;

  // /api/qcode/log を内部呼び出ししてログを取得
  const qp = new URLSearchParams();
  qp.set('limit', '5000'); // 広めに
  if (days && !start && !end) qp.set('days', days);
  if (start) qp.set('from', start);
  if (end) qp.set('to', end);
  if (user) qp.set('user', user);
  const logUrl = new URL(`/api/qcode/log?${qp.toString()}`, url.origin);

  const res = await fetch(logUrl.toString(), {
    headers: {
      cookie: req.headers.get('cookie') ?? '',
      authorization: req.headers.get('authorization') ?? '',
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    return NextResponse.json({ error: `qcode/log ${res.status}` }, { status: 500 });
  }
  const json = await res.json();
  const items: any[] = json.items ?? [];

  // 日付 -> Q別カウント
  const byDate: Record<string, { q1: number; q2: number; q3: number; q4: number; q5: number }> = {};
  for (const it of items) {
    const date: string = it?.for_date;
    const q: string | undefined = it?.q_code?.currentQ;
    if (!date || !q) continue;
    if (!byDate[date]) byDate[date] = { q1: 0, q2: 0, q3: 0, q4: 0, q5: 0 };
    if (q === 'Q1') byDate[date].q1++;
    if (q === 'Q2') byDate[date].q2++;
    if (q === 'Q3') byDate[date].q3++;
    if (q === 'Q4') byDate[date].q4++;
    if (q === 'Q5') byDate[date].q5++;
  }

  // 出力配列（日付昇順）
  const out = Object.entries(byDate)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, ...v }));

  return NextResponse.json(out);
}
