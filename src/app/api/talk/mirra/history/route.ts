// src/app/api/talk/history/route.ts
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  // とりあえず空の履歴を返す（404が消えるかの生存確認用）
  return NextResponse.json({ ok: true, items: [] });
}
