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

  // ← ここに既存の append 処理を戻してください
  // await appendConversation(id, body);

  return NextResponse.json({ ok: true, id });
}
