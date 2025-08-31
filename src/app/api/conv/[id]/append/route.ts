// src/app/api/conv/[id]/append/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

// Next.js 15 では context.params は Promise です
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params; // ← Promise から展開

  // ボディは任意（元の処理をここに戻してください）
  let body: unknown = undefined;
  try {
    body = await req.json();
  } catch {
    // JSONなしでもOKにする
  }

  // ここに既存の append 処理を貼り戻し
  // await appendConversation(id, body, ...)

  return NextResponse.json({ ok: true, id });
}
