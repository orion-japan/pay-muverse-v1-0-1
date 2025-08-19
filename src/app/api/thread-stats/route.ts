// src/app/api/thread-stats/route.ts
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ids = searchParams.get('ids'); // "id1,id2,..." を想定
  const list = ids ? ids.split(',').map((s) => s.trim()).filter(Boolean) : [];

  // TODO: ここを Supabase 集計に差し替え
  const stats = Object.fromEntries(
    list.map((id) => [id, { replies: 0, reacts: 0 }])
  );

  return NextResponse.json({ stats });
}
