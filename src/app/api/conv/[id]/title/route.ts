// src/app/api/conv/[id]/title/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

export async function POST(req: Request, { params }: any) {
  const id: string = params?.id;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    body = undefined;
  }

  // ← ここに既存のタイトル更新処理を戻してください
  // await updateConversationTitle(id, body?.title);

  return NextResponse.json({ ok: true, id /*, title: body?.title */ });
}
