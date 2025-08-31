// src/app/api/conv/[id]/append/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

export async function POST(req: Request, { params }: any) {
  const id: string = params?.id;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = undefined;
  }

  // ここに元の append 処理を戻す
  // await appendConversation(id, body);

  return NextResponse.json({ ok: true, id });
}
