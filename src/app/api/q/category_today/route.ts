export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/q/category_today[?user=xxxx]
 * - 当日 (JST) の Self/Vision/Event/AI の件数を返す
 *  intent の値は Qページと同じ想定: self_post / vision_check / event_attend / ai_response など
 */
function toJstDateStr(d = new Date()) {
  const j = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const y = j.getFullYear();
  const m = String(j.getMonth() + 1).padStart(2, '0');
  const day = String(j.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const user = url.searchParams.get('user') ?? undefined;

  const today = toJstDateStr();
  const qp = new URLSearchParams({ limit: '5000', from: today, to: today });
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

  // intent をカテゴリに寄せる（プロジェクトの値に合わせて必要なら追加）
  let self = 0,
    vision = 0,
    event = 0,
    ai = 0;
  for (const it of items) {
    const intent: string | undefined = it?.intent;
    if (!intent) continue;
    if (intent === 'self_post') self++;
    else if (intent === 'vision_check') vision++;
    else if (intent === 'event_attend') event++;
    else if (intent === 'ai_response' || intent === 'ai_summary') ai++;
  }

  return NextResponse.json({ self, vision, event, ai });
}
