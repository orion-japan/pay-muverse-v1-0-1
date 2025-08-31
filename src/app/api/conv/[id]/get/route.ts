export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

export async function GET(_req: Request, { params }: any) {
  const id: string = params?.id;

  // ← ここに既存の取得処理を戻してください
  // const conv = await getConversation(id);

  return NextResponse.json({ ok: true, id /*, conv*/ });
}
